const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("rate-limiter-flexible");
const Joi = require("joi");
require("dotenv").config();

const logger = require("./utils/logger");
const CommentManager = require("./services/CommentManager");
const NotificationManager = require("./services/NotificationManager");

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure CORS
const corsOptions = {
  origin: process.env.CORS_ORIGIN || "https://local.pendo.io:3000",
  methods: ["GET", "POST"],
  credentials: true,
};

// Initialize Socket.IO with CORS
const io = socketIo(server, {
  cors: corsOptions,
  transports: ["websocket", "polling"],
});

// Middleware
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// Rate limiting
const rateLimiter = new rateLimit.RateLimiterMemory({
  keyGenerator: (req, res, next) => {
    return req.ip;
  },
  points: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  duration: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
});

// Initialize managers
const commentManager = new CommentManager();
const notificationManager = new NotificationManager();

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    connections: io.engine.clientsCount,
  });
});

// Socket.IO connection handling
// JWT authentication disabled - accept all connections

io.on("connection", (socket) => {
  // Extract user info from socket handshake (no JWT required)
  const userInfo = socket.handshake.auth?.user || socket.handshake.query?.user;

  if (userInfo && typeof userInfo === "string") {
    try {
      // Parse JSON string if needed
      socket.userInfo = JSON.parse(userInfo);
      socket.userId =
        socket.userInfo.userId ||
        socket.userInfo.id ||
        socket.userInfo.userSnippylyId;
    } catch (e) {
      // If parsing fails, create basic user info
      socket.userInfo = { username: userInfo, name: userInfo };
      socket.userId = `user-${socket.id}`;
    }
  } else if (userInfo && typeof userInfo === "object") {
    // User info already parsed
    socket.userInfo = userInfo;
    socket.userId = userInfo.userId || userInfo.id || userInfo.userSnippylyId;
  } else {
    // No user info provided - create guest user
    socket.userId = `guest-${socket.id}`;
    socket.userInfo = {
      id: socket.userId,
      username: `Guest${socket.id.substring(0, 6)}`,
      name: `Guest User`,
      email: `guest@example.com`,
      role: "user",
    };
  }

  logger.info(`Client connected: ${socket.id}`, {
    userId: socket.userId,
    userInfo: socket.userInfo,
  });

  // Join user to their personal notification room
  socket.join(`user:${socket.userId}`);

  // Handle joining comment threads
  socket.on("join_thread", async (data) => {
    try {
      const { error, value } = validateJoinThread(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid join thread data",
          details: error.details,
        });
        return;
      }

      const { threadId, threadType } = value;
      const roomName = `${threadType}:${threadId}`;

      await socket.join(roomName);

      // Send existing comments for this thread
      const comments = await commentManager.getCommentsForThread(
        threadId,
        threadType
      );
      socket.emit("thread_comments", { threadId, threadType, comments });

      logger.info(
        `User ${socket.userId} joined thread ${threadId} of type ${threadType}`
      );
    } catch (error) {
      logger.error("Error joining thread:", error);
      socket.emit("error", { message: "Failed to join thread" });
    }
  });

  // Handle leaving comment threads
  socket.on("leave_thread", async (data) => {
    try {
      const { error, value } = validateLeaveThread(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid leave thread data",
          details: error.details,
        });
        return;
      }

      const { threadId, threadType } = value;
      const roomName = `${threadType}:${threadId}`;

      await socket.leave(roomName);
      logger.info(
        `User ${socket.userId} left thread ${threadId} of type ${threadType}`
      );
    } catch (error) {
      logger.error("Error leaving thread:", error);
      socket.emit("error", { message: "Failed to leave thread" });
    }
  });

  // Handle new comments
  socket.on("new_comment", async (data) => {
    try {
      // Apply rate limiting
      try {
        await rateLimiter.consume(socket.id);
      } catch (rateLimiterRes) {
        socket.emit("error", {
          message: "Rate limit exceeded",
          retryAfter: rateLimiterRes.msBeforeNext,
        });
        return;
      }

      const { error, value } = validateNewComment(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid comment data",
          details: error.details,
        });
        return;
      }

      const comment = await commentManager.createComment({
        ...value,
        userId: socket.userId,
        userInfo: socket.userInfo,
      });

      // Get parent comment if this is a reply
      const parentComment = comment.parentId
        ? await commentManager.getComment(comment.parentId)
        : null;

      // Broadcast to all users in the thread
      const roomName = `${comment.threadType}:${comment.threadId}`;
      io.to(roomName).emit("comment_added", comment, parentComment);

      // Create notifications for thread participants
      await notificationManager.createCommentNotification(
        comment,
        socket.userId
      );

      logger.info(`New comment created by user ${socket.userId}`, {
        commentId: comment.id,
        parentId: comment.parentId,
        isReply: !!comment.parentId,
        hasParentComment: !!parentComment,
      });
    } catch (error) {
      logger.error("Error creating comment:", error);
      socket.emit("error", { message: "Failed to create comment" });
    }
  });

  // Handle comment updates
  socket.on("update_comment", async (data) => {
    try {
      const { error, value } = validateUpdateComment(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid update data",
          details: error.details,
        });
        return;
      }

      const updatedComment = await commentManager.updateComment(
        value.commentId,
        value.content,
        socket.userId
      );

      if (updatedComment) {
        const roomName = `${updatedComment.threadType}:${updatedComment.threadId}`;
        io.to(roomName).emit("comment_updated", updatedComment);
        logger.info(
          `Comment ${value.commentId} updated by user ${socket.userId}`
        );
      } else {
        socket.emit("error", { message: "Comment not found or unauthorized" });
      }
    } catch (error) {
      logger.error("Error updating comment:", error);
      socket.emit("error", { message: "Failed to update comment" });
    }
  });

  // Handle comment deletion
  socket.on("delete_comment", async (data) => {
    try {
      const { error, value } = validateDeleteComment(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid delete data",
          details: error.details,
        });
        return;
      }

      const deletedComment = await commentManager.deleteComment(
        value.commentId,
        socket.userId
      );

      if (deletedComment) {
        const roomName = `${deletedComment.threadType}:${deletedComment.threadId}`;
        io.to(roomName).emit("comment_deleted", { commentId: value.commentId });
        logger.info(
          `Comment ${value.commentId} deleted by user ${socket.userId}`
        );
      } else {
        socket.emit("error", { message: "Comment not found or unauthorized" });
      }
    } catch (error) {
      logger.error("Error deleting comment:", error);
      socket.emit("error", { message: "Failed to delete comment" });
    }
  });

  // Handle notification acknowledgment
  socket.on("ack_notification", async (data) => {
    try {
      const { error, value } = validateAckNotification(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid notification data",
          details: error.details,
        });
        return;
      }

      await notificationManager.markAsRead(value.notificationId, socket.userId);
      logger.info(
        `Notification ${value.notificationId} acknowledged by user ${socket.userId}`
      );
    } catch (error) {
      logger.error("Error acknowledging notification:", error);
      socket.emit("error", { message: "Failed to acknowledge notification" });
    }
  });

  // Handle getting unread notifications
  socket.on("get_notifications", async () => {
    try {
      const notifications = await notificationManager.getUnreadNotifications(
        socket.userId
      );
      socket.emit("notifications", notifications);
    } catch (error) {
      logger.error("Error getting notifications:", error);
      socket.emit("error", { message: "Failed to get notifications" });
    }
  });

  // Handle typing indicators
  socket.on("typing_start", (data) => {
    const { error, value } = validateTyping(data);
    if (error) return;

    const roomName = `${value.threadType}:${value.threadId}`;
    socket.to(roomName).emit("user_typing", {
      userId: socket.userId,
      userInfo: socket.userInfo,
      threadId: value.threadId,
      threadType: value.threadType,
    });
  });

  socket.on("typing_stop", (data) => {
    const { error, value } = validateTyping(data);
    if (error) return;

    const roomName = `${value.threadType}:${value.threadId}`;
    socket.to(roomName).emit("user_stopped_typing", {
      userId: socket.userId,
      threadId: value.threadId,
      threadType: value.threadType,
    });
  });

  // Handle getting comment threads (your required event)
  socket.on("get_comment_threads", async (data) => {
    try {
      const { error, value } = validateGetCommentThreads(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid get threads data",
          details: error.details,
        });
        return;
      }

      const { itemId, user } = value;

      // Join the user to the item room so they can receive broadcasts
      const roomName = `item:${itemId}`;
      await socket.join(roomName);

      const threads = await commentManager.getCommentThreads(itemId, user);
      socket.emit("comment_threads_updated", { threads });

      logger.info(`Comment threads retrieved for item ${itemId}`, {
        userId: socket.userId,
        roomName: roomName,
        joinedRoom: true,
      });
    } catch (error) {
      logger.error("Error getting comment threads:", error);
      socket.emit("error", { message: "Failed to get comment threads" });
    }
  });

  // Handle adding comment (your required event structure)
  socket.on("add_comment", async (data) => {
    try {
      // Apply rate limiting
      try {
        await rateLimiter.consume(socket.id);
      } catch (rateLimiterRes) {
        socket.emit("error", {
          message: "Rate limit exceeded",
          retryAfter: rateLimiterRes.msBeforeNext,
        });
        return;
      }

      const { error, value } = validateAddComment(data);
      if (error) {
        logger.warn(`❌ Validation failed for add_comment`, {
          receivedData: data,
          validationErrors: error.details,
          userId: socket.userId,
        });
        socket.emit("error", {
          message: "Invalid comment data",
          details: error.details,
        });
        return;
      }

      logger.info(`📥 Processing add_comment request`, {
        data: value,
        userId: socket.userId,
        hasAnnotationId: !!value.annotationId,
        hasItemId: !!value.itemId,
        hasParentId: !!value.parentId,
        type: value.type,
      });

      const {
        itemId,
        annotationId,
        content,
        type,
        context,
        user,
        parentId,
        isReply,
        parentCommentId,
        parentAnnotationId,
      } = value;

      // Check if this is a reply
      const detectIsReply = isReply === true || type === "reply";

      logger.info(`🔍 Reply detection`, {
        isReply: detectIsReply,
        type: type,
        hasParentCommentId: !!parentCommentId,
        hasParentAnnotationId: !!parentAnnotationId,
        annotationId: annotationId,
      });

      let actualItemId = itemId;
      let actualParentId = parentId;
      let replyToAnnotationId = null;

      if (detectIsReply) {
        logger.info(`💬 Processing as reply to parent:`, {
          parentCommentId: parentCommentId,
          parentAnnotationId: parentAnnotationId || annotationId,
        });

        // For replies, use parentAnnotationId or annotationId to find the thread
        const threadAnnotationId = parentAnnotationId || annotationId;
        const thread = await commentManager.getCommentThread(
          threadAnnotationId
        );

        if (thread && thread.comments.length > 0) {
          // Get itemId from the first comment in the thread
          actualItemId = thread.comments[0].itemId;

          // Set parentId to the specific comment being replied to
          actualParentId = parentCommentId || thread.comments[0].id;

          // Keep the same annotation ID to add to existing thread
          replyToAnnotationId = threadAnnotationId;

          logger.info(`🔗 Reply thread found`, {
            threadAnnotationId,
            itemId: actualItemId,
            parentId: actualParentId,
            threadCommentsCount: thread.comments.length,
          });
        } else {
          throw new Error(
            `Thread not found for annotationId: ${threadAnnotationId}`
          );
        }
      } else if (annotationId && !itemId) {
        // Handle legacy case: when annotationId is provided for new thread
        const thread = await commentManager.getCommentThread(annotationId);
        if (thread && thread.comments.length > 0) {
          actualItemId = thread.comments[0].itemId;

          logger.info(`🔗 Converting annotationId to itemId`, {
            annotationId,
            itemId: actualItemId,
          });
        } else {
          throw new Error(`Thread not found for annotationId: ${annotationId}`);
        }
      }

      const comment = await commentManager.createCommentWithAnnotation({
        itemId: actualItemId,
        content,
        type: detectIsReply ? "reply" : type || "comment",
        context,
        parentId: actualParentId,
        replyToAnnotationId: replyToAnnotationId, // Use existing annotation if replying
        isReply: detectIsReply,
        user: user || socket.userInfo,
      });

      // Get parent comment if this is a reply
      const parentComment = comment.parentId
        ? await commentManager.getComment(comment.parentId)
        : null;

      // Get the full thread after adding comment
      const thread = await commentManager.getCommentThread(
        comment.annotationId
      );

      // Join the user to the item room FIRST (before broadcasting)
      const roomName = `item:${actualItemId}`;
      await socket.join(roomName);

      // Get updated threads early for logging
      const updatedThreads = await commentManager.getCommentThreads(
        actualItemId
      );
      const updatedThread = updatedThreads.find(
        (t) => t.annotationId === comment.annotationId
      );

      // Broadcast to all users in the item room
      const broadcastData = {
        annotationId: comment.annotationId,
        comment: comment,
        thread: thread,
        parentComment: parentComment,
      };

      // Debug: Log the exact data being sent to frontend
      logger.info(`📋 Comment data being broadcast:`, {
        commentId: comment.id,
        annotationId: comment.annotationId,
        userId: comment.userId,
        username: comment.username,
        name: comment.name,
        email: comment.email,
        type: comment.type,
        parentId: comment.parentId,
        isReply: comment.isReply,
        hasParentComment: !!parentComment,
        parentCommentId: parentComment?.id,
        threadAfterReply: updatedThread
          ? updatedThread.comments.length
          : "unknown",
        userInfo: comment.userInfo,
        hasUserInfo: !!comment.userInfo,
      });

      io.to(roomName).emit("comment_added", broadcastData);
      logger.info(`🚀 Broadcasting comment_added to room ${roomName}`, {
        event: "comment_added",
        roomName,
        annotationId: comment.annotationId,
      });

      // Also emit directly to sender as fallback
      socket.emit("comment_added", broadcastData);
      logger.info(`📤 Emitting comment_added directly to sender ${socket.id}`);

      // Emit updated threads to all users in the room
      io.to(roomName).emit("comment_threads_updated", {
        threads: updatedThreads,
      });

      logger.info(
        `🔄 Broadcasting comment_threads_updated to room ${roomName}`,
        {
          event: "comment_threads_updated",
          threadsCount: updatedThreads.length,
          updatedThreadComments: updatedThread
            ? updatedThread.comments.length
            : 0,
          isReply: comment.isReply,
        }
      );

      if (comment.isReply) {
        logger.info(`🔄 Broadcasted thread update with replies:`, {
          threadId: comment.annotationId,
          commentsInThread: updatedThread ? updatedThread.comments.length : 0,
          isReply: true,
        });
      }

      logger.info(
        `New comment added and broadcasted for item ${actualItemId}`,
        {
          annotationId: comment.annotationId,
          userId: socket.userId,
          roomName: roomName,
          parentId: comment.parentId,
          isReply: !!comment.parentId,
          broadcastSent: true,
        }
      );
    } catch (error) {
      logger.error("Error adding comment:", error);
      socket.emit("error", { message: "Failed to add comment" });
    }
  });

  // Handle updating comment status (your required event)
  socket.on("update_comment_status", async (data) => {
    try {
      const { error, value } = validateUpdateCommentStatus(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid status update data",
          details: error.details,
        });
        return;
      }

      const { annotationId, status, user } = value;
      const updated = await commentManager.updateCommentStatus(
        annotationId,
        status,
        user || socket.userInfo
      );

      if (updated) {
        // Broadcast status update to all users in the annotation
        const roomName = `annotation:${annotationId}`;
        io.to(roomName).emit("comment_status_updated", {
          annotationId,
          status,
        });

        logger.info(`Comment status updated for annotation ${annotationId}`, {
          status,
          userId: socket.userId,
        });
      } else {
        socket.emit("error", { message: "Failed to update comment status" });
      }
    } catch (error) {
      logger.error("Error updating comment status:", error);
      socket.emit("error", { message: "Failed to update comment status" });
    }
  });

  // Handle adding reaction (your required event)
  socket.on("add_reaction", async (data) => {
    try {
      const { error, value } = validateAddReaction(data);
      if (error) {
        socket.emit("error", {
          message: "Invalid reaction data",
          details: error.details,
        });
        return;
      }

      const { annotationId, commentId, reaction, user } = value;
      const reactionResult = await commentManager.addReaction(
        annotationId,
        commentId,
        reaction,
        user || socket.userInfo
      );

      if (reactionResult) {
        // Broadcast reaction to all users in the annotation
        const roomName = `annotation:${annotationId}`;
        io.to(roomName).emit("reaction_added", {
          annotationId,
          commentId,
          reaction: reactionResult,
        });

        logger.info(`Reaction added to comment ${commentId}`, {
          annotationId,
          reaction: reaction,
          userId: socket.userId,
        });
      } else {
        socket.emit("error", { message: "Failed to add reaction" });
      }
    } catch (error) {
      logger.error("Error adding reaction:", error);
      socket.emit("error", { message: "Failed to add reaction" });
    }
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    logger.info(`Client disconnected: ${socket.id}`, {
      userId: socket.userId,
      reason,
    });
  });
});

// Validation schemas
const joinThreadSchema = Joi.object({
  threadId: Joi.string().required(),
  threadType: Joi.string()
    .valid("post", "article", "discussion", "task")
    .required(),
});

const leaveThreadSchema = Joi.object({
  threadId: Joi.string().required(),
  threadType: Joi.string()
    .valid("post", "article", "discussion", "task")
    .required(),
});

const newCommentSchema = Joi.object({
  threadId: Joi.string().required(),
  threadType: Joi.string()
    .valid("post", "article", "discussion", "task")
    .required(),
  content: Joi.string().min(1).max(2000).required(),
  parentId: Joi.string().optional(),
});

const updateCommentSchema = Joi.object({
  commentId: Joi.string().required(),
  content: Joi.string().min(1).max(2000).required(),
});

const deleteCommentSchema = Joi.object({
  commentId: Joi.string().required(),
});

const ackNotificationSchema = Joi.object({
  notificationId: Joi.string().required(),
});

const typingSchema = Joi.object({
  threadId: Joi.string().required(),
  threadType: Joi.string()
    .valid("post", "article", "discussion", "task")
    .required(),
});

// New validation schemas for your required events
const getCommentThreadsSchema = Joi.object({
  itemId: Joi.string().required(),
  user: Joi.object().optional(),
});

const addCommentSchema = Joi.object({
  itemId: Joi.string().optional(),
  annotationId: Joi.string().optional(),
  content: Joi.string().min(1).max(2000).required(),
  type: Joi.string().optional(),
  context: Joi.object().optional(),
  user: Joi.object().optional(),
  parentId: Joi.string().optional(),
  isReply: Joi.boolean().optional(),
  parentCommentId: Joi.string().optional(),
  parentAnnotationId: Joi.string().optional(),
  threadId: Joi.string().optional(), // Allow threadId from frontend
}).or("itemId", "annotationId"); // Require either itemId OR annotationId

const updateCommentStatusSchema = Joi.object({
  annotationId: Joi.string().required(),
  status: Joi.string().required(),
  user: Joi.object().optional(),
});

const addReactionSchema = Joi.object({
  annotationId: Joi.string().required(),
  commentId: Joi.string().required(),
  reaction: Joi.string().required(),
  user: Joi.object().optional(),
});

// Validation functions
function validateJoinThread(data) {
  return joinThreadSchema.validate(data);
}

function validateLeaveThread(data) {
  return leaveThreadSchema.validate(data);
}

function validateNewComment(data) {
  return newCommentSchema.validate(data);
}

function validateUpdateComment(data) {
  return updateCommentSchema.validate(data);
}

function validateDeleteComment(data) {
  return deleteCommentSchema.validate(data);
}

function validateAckNotification(data) {
  return ackNotificationSchema.validate(data);
}

function validateTyping(data) {
  return typingSchema.validate(data);
}

// New validation functions for your required events
function validateGetCommentThreads(data) {
  return getCommentThreadsSchema.validate(data);
}

function validateAddComment(data) {
  return addCommentSchema.validate(data);
}

function validateUpdateCommentStatus(data) {
  return updateCommentStatusSchema.validate(data);
}

function validateAddReaction(data) {
  return addReactionSchema.validate(data);
}

// Error handling
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`WebSocket server is running on port ${PORT}`);
});

module.exports = { app, server, io };
