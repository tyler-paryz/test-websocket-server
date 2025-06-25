const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class CommentManager {
  constructor() {
    // In-memory storage for demo purposes
    // In production, you'd use a real database
    this.comments = new Map();
    this.threadComments = new Map(); // threadId -> Set of commentIds
  }

  async createComment(commentData) {
    const comment = {
      id: uuidv4(),
      threadId: commentData.threadId,
      threadType: commentData.threadType,
      content: commentData.content,
      userId: commentData.userId,
      userInfo: commentData.userInfo,
      parentId: commentData.parentId || null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      isDeleted: false,
      reactions: {},
      replies: []
    };

    // Store the comment
    this.comments.set(comment.id, comment);

    // Add to thread mapping
    const threadKey = `${commentData.threadType}:${commentData.threadId}`;
    if (!this.threadComments.has(threadKey)) {
      this.threadComments.set(threadKey, new Set());
    }
    this.threadComments.get(threadKey).add(comment.id);

    // If this is a reply, add it to parent's replies
    if (comment.parentId) {
      const parentComment = this.comments.get(comment.parentId);
      if (parentComment) {
        parentComment.replies.push(comment.id);
      }
    }

    return comment;
  }

    async updateComment(commentId, newContent, userId) {
        const comment = this.comments.get(commentId);


    if (!comment) {
      logger.warn(`Comment not found: ${commentId}`);
      return null;
    }

    if (comment.userId !== userId) {
      logger.warn(`Unauthorized comment update attempt`, {
        commentId,
        userId,
        commentUserId: comment.userId
      });
      return null;
    }

    comment.content = newContent;
    comment.updatedAt = new Date().toISOString();

    logger.info('test', { comment })

    logger.info(`Comment updated: ${commentId}`, { userId });
    return comment;
  }

  async deleteComment(commentId, userId) {
    const comment = this.comments.get(commentId);
    if (!comment) {
      logger.warn(`Comment not found: ${commentId}`);
      return null;
    }

    if (comment.userId !== userId) {
      logger.warn(`Unauthorized comment deletion attempt`, {
        commentId,
        userId,
        commentUserId: comment.userId
      });
      return null;
    }

    // Soft delete
    comment.isDeleted = true;
    comment.content = '[Comment deleted]';
    comment.updatedAt = new Date().toISOString();

    logger.info('replies', { comment })

    if(comment.replies.length > 0) {
        for(let reply of comment.replies) {
            const replyToDelete = this.comments.get(reply)

            replyToDelete.isDeleted = true
            replyToDelete.content = '[Comment deleted]';
            replyToDelete.updatedAt = new Date().toISOString();

            logger.info(`Comment deleted: ${replyToDelete}`, { replyToDelete });

        }

    }

    logger.info(`Comment deleted: ${commentId}`, { userId });
    return this.comments;
  }

  async getCommentsForThread(threadId, threadType, limit = 50, offset = 0) {
    const threadKey = `${threadType}:${threadId}`;
    const commentIds = this.threadComments.get(threadKey);

    if (!commentIds) {
      return [];
    }

    const comments = Array.from(commentIds)
      .map(id => this.comments.get(id))
      .filter(comment => comment && !comment.isDeleted)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(offset, offset + limit);

    // Build threaded structure
    const topLevelComments = comments.filter(c => !c.parentId);
    const repliesMap = new Map();

    // Group replies by parent
    comments.filter(c => c.parentId).forEach(reply => {
      if (!repliesMap.has(reply.parentId)) {
        repliesMap.set(reply.parentId, []);
      }
      repliesMap.get(reply.parentId).push(reply);
    });

    // Attach replies to their parents
    const buildCommentTree = (comment) => {
      const replies = repliesMap.get(comment.id) || [];
      return {
        ...comment,
        replies: replies.map(buildCommentTree)
      };
    };

    const threadedComments = topLevelComments.map(buildCommentTree);

    logger.info(`Retrieved ${threadedComments.length} comments for thread ${threadId}`);
    return threadedComments;
  }

  async getComment(commentId) {
    return this.comments.get(commentId);
  }

  async addReaction(commentId, userId, reactionType) {
    const comment = this.comments.get(commentId);
    if (!comment) return null;

    if (!comment.reactions[reactionType]) {
      comment.reactions[reactionType] = new Set();
    }

    // Remove user from all other reactions for this comment
    Object.keys(comment.reactions).forEach(type => {
      if (type !== reactionType) {
        comment.reactions[type].delete(userId);
      }
    });

    // Toggle the reaction
    if (comment.reactions[reactionType].has(userId)) {
      comment.reactions[reactionType].delete(userId);
    } else {
      comment.reactions[reactionType].add(userId);
    }

    // Convert Sets to arrays for JSON serialization
    const reactionsForResponse = {};
    Object.keys(comment.reactions).forEach(type => {
      reactionsForResponse[type] = Array.from(comment.reactions[type]);
    });

    return {
      ...comment,
      reactions: reactionsForResponse
    };
  }

  async getThreadParticipants(threadId, threadType) {
    const threadKey = `${threadType}:${threadId}`;
    const commentIds = this.threadComments.get(threadKey);

    if (!commentIds) {
      return [];
    }

    const participants = new Set();
    commentIds.forEach(id => {
      const comment = this.comments.get(id);
      if (comment && !comment.isDeleted) {
        participants.add(comment.userId);
      }
    });

    return Array.from(participants);
  }

  // Get statistics for a thread
  async getThreadStats(threadId, threadType) {
    const threadKey = `${threadType}:${threadId}`;
    const commentIds = this.threadComments.get(threadKey);

    if (!commentIds) {
      return { totalComments: 0, participants: 0, lastActivity: null };
    }

    const comments = Array.from(commentIds)
      .map(id => this.comments.get(id))
      .filter(comment => comment && !comment.isDeleted);

    const participants = new Set(comments.map(c => c.userId));
    const lastActivity = comments.length > 0
      ? Math.max(...comments.map(c => new Date(c.updatedAt || c.createdAt).getTime()))
      : null;

    return {
      totalComments: comments.length,
      participants: participants.size,
      lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null
    };
  }

  // NEW METHODS FOR YOUR FRONTEND REQUIREMENTS

  // Get comment threads for an item
  async getCommentThreads(itemId, user) {
    const itemKey = `item:${itemId}`;
    const commentIds = this.threadComments.get(itemKey) || new Set();

    const threads = [];
    const annotationMap = new Map();

    // Group comments by annotation ID
    commentIds.forEach(id => {
      const comment = this.comments.get(id);
      if (comment && !comment.isDeleted) {
        const annotationId = comment.annotationId || comment.threadId;
        if (!annotationMap.has(annotationId)) {
          annotationMap.set(annotationId, []);
        }
        annotationMap.get(annotationId).push(comment);
      }
    });

    // Build thread structure
    annotationMap.forEach((comments, annotationId) => {
      const thread = {
        annotationId,
        comments: comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
        status: comments[0]?.status || 'open',
        lastActivity: Math.max(...comments.map(c => new Date(c.updatedAt || c.createdAt).getTime()))
      };
      threads.push(thread);
    });

    logger.info(`Retrieved ${threads.length} comment threads for item ${itemId}`);
    return threads.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  // Create comment with annotation support
  async createCommentWithAnnotation(data) {
    const { itemId, content, type, context, user, parentId, replyToAnnotationId, isReply } = data;

    // If this is a reply to an existing annotation, use that annotationId
    // Otherwise, create a new annotation
    const annotationId = replyToAnnotationId || uuidv4();

    // Ensure user info has all required fields for frontend
    const normalizedUserInfo = {
      id: user.userId || user.userSnippylyId || user.id,
      userId: user.userId || user.userSnippylyId || user.id,
      username: user.clientUserName || user.username || user.name || 'Unknown User',
      name: user.name || user.clientUserName || user.username || 'Unknown User',
      email: user.email || 'unknown@example.com',
      firstName: user.firstName || (user.name || '').split(' ')[0] || 'Unknown',
      lastName: user.lastName || (user.name || '').split(' ')[1] || 'User',
      role: user.isAdmin ? 'admin' : (user.role || 'user'),
      textColor: user.textColor || '#000000',
      color: user.color || '#E2F0FF',
      organizationId: user.organizationId || user.clientOrganizationId,
      userSnippylyId: user.userSnippylyId
    };

    const comment = {
      id: uuidv4(),
      annotationId,
      itemId,
      threadId: itemId, // Keep for backward compatibility
      threadType: 'item',
      content,
      type: type || 'comment',
      context: context || {},
      parentId: parentId || null,
      isReply: isReply || false,
      userId: normalizedUserInfo.id,
      userInfo: normalizedUserInfo,
      // Add user fields directly to comment for easier access
      username: normalizedUserInfo.username,
      name: normalizedUserInfo.name,
      email: normalizedUserInfo.email,
      firstName: normalizedUserInfo.firstName,
      lastName: normalizedUserInfo.lastName,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: null,
      isDeleted: false,
      reactions: {},
      replies: []
    };

    // Store the comment
    this.comments.set(comment.id, comment);

    // Add to item mapping
    const itemKey = `item:${itemId}`;
    if (!this.threadComments.has(itemKey)) {
      this.threadComments.set(itemKey, new Set());
    }
    this.threadComments.get(itemKey).add(comment.id);

    // If this is a reply, add it to parent's replies
    if (comment.parentId) {
      const parentComment = this.comments.get(comment.parentId);
      if (parentComment) {
        parentComment.replies.push(comment.id);
      }
    }

    logger.info(`Comment with annotation created: ${comment.id}`, {
      annotationId,
      itemId,
      userId: user.userId || user.id,
      isReply: !!parentId,
      isNewAnnotation: !replyToAnnotationId,
      replyToAnnotationId: replyToAnnotationId || null
    });

    return comment;
  }

  // Get a specific comment thread by annotation ID
  async getCommentThread(annotationId) {
    const comments = [];

    this.comments.forEach(comment => {
      if (comment.annotationId === annotationId && !comment.isDeleted) {
        comments.push(comment);
      }
    });

    return {
      annotationId,
      comments: comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
      status: comments[0]?.status || 'open'
    };
  }

  // Update comment status
  async updateCommentStatus(annotationId, status, user) {
    let updated = false;

    this.comments.forEach(comment => {
      if (comment.annotationId === annotationId) {
        comment.status = status;
        comment.updatedAt = new Date().toISOString();
        updated = true;
      }
    });

    if (updated) {
      logger.info(`Comment status updated for annotation ${annotationId}`, {
        status,
        userId: user.userId || user.id
      });
    }

    return updated;
  }

  // Add reaction to a comment
  async addReaction(annotationId, commentId, reactionType, user) {
    const comment = this.comments.get(commentId);

    if (!comment || comment.annotationId !== annotationId) {
      logger.warn(`Comment not found or annotation mismatch: ${commentId}, ${annotationId}`);
      return null;
    }

    if (!comment.reactions[reactionType]) {
      comment.reactions[reactionType] = new Set();
    }

    const userId = user.userId || user.id;

    // Toggle the reaction
    if (comment.reactions[reactionType].has(userId)) {
      comment.reactions[reactionType].delete(userId);
    } else {
      // Remove user from all other reactions for this comment
      Object.keys(comment.reactions).forEach(type => {
        if (type !== reactionType) {
          comment.reactions[type].delete(userId);
        }
      });
      comment.reactions[reactionType].add(userId);
    }

    comment.updatedAt = new Date().toISOString();

    // Convert Sets to arrays for JSON serialization
    const reactionsForResponse = {};
    Object.keys(comment.reactions).forEach(type => {
      reactionsForResponse[type] = Array.from(comment.reactions[type]);
    });

    logger.info(`Reaction ${reactionType} toggled for comment ${commentId}`, {
      annotationId,
      userId
    });

    return {
      type: reactionType,
      users: reactionsForResponse[reactionType],
      userId
    };
  }
}

module.exports = CommentManager;
