const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class NotificationManager {
  constructor() {
    // In-memory storage for demo purposes
    // In production, you'd use a real database
    this.notifications = new Map();
    this.userNotifications = new Map(); // userId -> Set of notificationIds
  }

  async createCommentNotification(comment, authorId) {
    try {
      // Don't send notification to the comment author
      const threadParticipants = await this.getThreadParticipants(
        comment.threadId, 
        comment.threadType
      );
      
      const recipients = threadParticipants.filter(userId => userId !== authorId);

      for (const recipientId of recipients) {
        const notification = {
          id: uuidv4(),
          type: 'new_comment',
          recipientId,
          data: {
            commentId: comment.id,
            threadId: comment.threadId,
            threadType: comment.threadType,
            authorId: comment.userId,
            authorInfo: comment.userInfo,
            content: this.truncateContent(comment.content, 100),
            isReply: !!comment.parentId
          },
          read: false,
          createdAt: new Date().toISOString()
        };

        await this.saveNotification(notification);
        
        // Here you would typically send the notification via Socket.IO
        // This is handled in the main server file
        logger.info(`Comment notification created for user ${recipientId}`, {
          notificationId: notification.id,
          commentId: comment.id
        });
      }
    } catch (error) {
      logger.error('Error creating comment notification:', error);
    }
  }

  async createCustomNotification(recipientId, type, data) {
    const notification = {
      id: uuidv4(),
      type,
      recipientId,
      data,
      read: false,
      createdAt: new Date().toISOString()
    };

    await this.saveNotification(notification);
    
    logger.info(`Custom notification created for user ${recipientId}`, {
      notificationId: notification.id,
      type
    });

    return notification;
  }

  async saveNotification(notification) {
    // Store the notification
    this.notifications.set(notification.id, notification);

    // Add to user mapping
    if (!this.userNotifications.has(notification.recipientId)) {
      this.userNotifications.set(notification.recipientId, new Set());
    }
    this.userNotifications.get(notification.recipientId).add(notification.id);
  }

  async getUnreadNotifications(userId, limit = 50) {
    const userNotificationIds = this.userNotifications.get(userId);
    
    if (!userNotificationIds) {
      return [];
    }

    const notifications = Array.from(userNotificationIds)
      .map(id => this.notifications.get(id))
      .filter(notification => notification && !notification.read)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);

    logger.info(`Retrieved ${notifications.length} unread notifications for user ${userId}`);
    return notifications;
  }

  async getAllNotifications(userId, limit = 50, offset = 0) {
    const userNotificationIds = this.userNotifications.get(userId);
    
    if (!userNotificationIds) {
      return [];
    }

    const notifications = Array.from(userNotificationIds)
      .map(id => this.notifications.get(id))
      .filter(notification => notification)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(offset, offset + limit);

    logger.info(`Retrieved ${notifications.length} notifications for user ${userId}`);
    return notifications;
  }

  async markAsRead(notificationId, userId) {
    const notification = this.notifications.get(notificationId);
    
    if (!notification) {
      logger.warn(`Notification not found: ${notificationId}`);
      return false;
    }

    if (notification.recipientId !== userId) {
      logger.warn(`Unauthorized notification access attempt`, {
        notificationId,
        userId,
        recipientId: notification.recipientId
      });
      return false;
    }

    notification.read = true;
    notification.readAt = new Date().toISOString();

    logger.info(`Notification marked as read: ${notificationId}`, { userId });
    return true;
  }

  async markAllAsRead(userId) {
    const userNotificationIds = this.userNotifications.get(userId);
    
    if (!userNotificationIds) {
      return 0;
    }

    let markedCount = 0;
    const readAt = new Date().toISOString();

    userNotificationIds.forEach(id => {
      const notification = this.notifications.get(id);
      if (notification && !notification.read) {
        notification.read = true;
        notification.readAt = readAt;
        markedCount++;
      }
    });

    logger.info(`Marked ${markedCount} notifications as read for user ${userId}`);
    return markedCount;
  }

  async deleteNotification(notificationId, userId) {
    const notification = this.notifications.get(notificationId);
    
    if (!notification) {
      logger.warn(`Notification not found: ${notificationId}`);
      return false;
    }

    if (notification.recipientId !== userId) {
      logger.warn(`Unauthorized notification deletion attempt`, {
        notificationId,
        userId,
        recipientId: notification.recipientId
      });
      return false;
    }

    // Remove from storage
    this.notifications.delete(notificationId);
    
    // Remove from user mapping
    const userNotificationIds = this.userNotifications.get(userId);
    if (userNotificationIds) {
      userNotificationIds.delete(notificationId);
    }

    logger.info(`Notification deleted: ${notificationId}`, { userId });
    return true;
  }

  async getNotificationStats(userId) {
    const userNotificationIds = this.userNotifications.get(userId);
    
    if (!userNotificationIds) {
      return { total: 0, unread: 0 };
    }

    const notifications = Array.from(userNotificationIds)
      .map(id => this.notifications.get(id))
      .filter(notification => notification);

    const unreadCount = notifications.filter(n => !n.read).length;

    return {
      total: notifications.length,
      unread: unreadCount
    };
  }

  // Helper method to get thread participants
  // This would typically be injected or accessed via a service
  async getThreadParticipants(threadId, threadType) {
    // This is a simplified implementation
    // In practice, you'd query your main database or use CommentManager
    return []; // Return empty array for now
  }

  // Helper method to truncate content
  truncateContent(content, maxLength) {
    if (content.length <= maxLength) {
      return content;
    }
    return content.substring(0, maxLength - 3) + '...';
  }

  // Clean up old notifications (call this periodically)
  async cleanupOldNotifications(daysOld = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    let deletedCount = 0;

    this.notifications.forEach((notification, id) => {
      if (new Date(notification.createdAt) < cutoffDate) {
        // Remove from storage
        this.notifications.delete(id);
        
        // Remove from user mapping
        const userNotificationIds = this.userNotifications.get(notification.recipientId);
        if (userNotificationIds) {
          userNotificationIds.delete(id);
        }
        
        deletedCount++;
      }
    });

    logger.info(`Cleaned up ${deletedCount} old notifications`);
    return deletedCount;
  }
}

module.exports = NotificationManager; 