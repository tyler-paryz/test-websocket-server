const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("rate-limiter-flexible");
const jwt = require("jsonwebtoken");
const Joi = require("joi");
require("dotenv").config();

const logger = require("./utils/logger");
const CommentManager = require("./services/CommentManager");
const NotificationManager = require("./services/NotificationManager");
const AuthMiddleware = require("./middleware/auth");

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
const authMiddleware = new AuthMiddleware();

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
//io.use(authMiddleware.socketAuth);

io.on("connection", (socket) => {
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
