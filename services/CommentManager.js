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
      updatedAt: new Date().toISOString(),
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

    logger.info(`Comment created: ${comment.id}`, { 
      threadId: comment.threadId, 
      userId: comment.userId 
    });

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

    logger.info(`Comment deleted: ${commentId}`, { userId });
    return comment;
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
      ? Math.max(...comments.map(c => new Date(c.updatedAt).getTime()))
      : null;

    return {
      totalComments: comments.length,
      participants: participants.size,
      lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null
    };
  }
}

module.exports = CommentManager; 