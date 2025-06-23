/**
 * Integration Example: How to use the WebSocket server from your main application
 * 
 * This example shows how to:
 * 1. Generate JWT tokens for WebSocket authentication
 * 2. Connect to the WebSocket server programmatically
 * 3. Send notifications to users
 * 4. Handle real-time events
 */

const io = require('socket.io-client');
const jwt = require('jsonwebtoken');

class WebSocketClient {
  constructor(serverUrl, jwtSecret) {
    this.serverUrl = serverUrl;
    this.jwtSecret = jwtSecret;
    this.socket = null;
  }

  // Generate a JWT token for a user
  generateToken(user) {
    return jwt.sign({
      userId: user.id,
      username: user.username,
      email: user.email,
      name: user.displayName,
      avatar: user.avatarUrl,
      role: user.role || 'user'
    }, this.jwtSecret, {
      expiresIn: '24h'
    });
  }

  // Connect to WebSocket server with user credentials
  async connect(user) {
    return new Promise((resolve, reject) => {
      const token = this.generateToken(user);
      
      this.socket = io(this.serverUrl, {
        auth: { token },
        transports: ['websocket', 'polling']
      });

      this.socket.on('connect', () => {
        console.log(`Connected to WebSocket server as ${user.username}`);
        resolve(this.socket);
      });

      this.socket.on('connect_error', (error) => {
        console.error('WebSocket connection failed:', error.message);
        reject(error);
      });

      this.socket.on('disconnect', (reason) => {
        console.log(`WebSocket disconnected: ${reason}`);
      });

      this.socket.on('error', (error) => {
        console.error('WebSocket error:', error);
      });

      // Set up event listeners
      this.setupEventListeners();
    });
  }

  setupEventListeners() {
    // Listen for new comments
    this.socket.on('comment_added', (comment) => {
      console.log('New comment received:', comment);
      // Handle new comment in your application
      this.handleNewComment(comment);
    });

    // Listen for notifications
    this.socket.on('notifications', (notifications) => {
      console.log(`Received ${notifications.length} notifications`);
      notifications.forEach(notification => {
        this.handleNotification(notification);
      });
    });

    // Listen for typing indicators
    this.socket.on('user_typing', (data) => {
      console.log(`${data.userInfo.username} is typing in ${data.threadType}:${data.threadId}`);
    });
  }

  // Join a comment thread
  async joinThread(threadId, threadType) {
    if (!this.socket) {
      throw new Error('Not connected to WebSocket server');
    }

    return new Promise((resolve) => {
      this.socket.emit('join_thread', { threadId, threadType });
      
      // Listen for thread comments
      this.socket.once('thread_comments', (data) => {
        console.log(`Joined thread ${threadType}:${threadId} with ${data.comments.length} comments`);
        resolve(data.comments);
      });
    });
  }

  // Create a new comment
  async createComment(threadId, threadType, content, parentId = null) {
    if (!this.socket) {
      throw new Error('Not connected to WebSocket server');
    }

    this.socket.emit('new_comment', {
      threadId,
      threadType,
      content,
      parentId
    });
  }

  // Get user notifications
  async getNotifications() {
    if (!this.socket) {
      throw new Error('Not connected to WebSocket server');
    }

    return new Promise((resolve) => {
      this.socket.emit('get_notifications');
      
      this.socket.once('notifications', (notifications) => {
        resolve(notifications);
      });
    });
  }

  // Mark notification as read
  markNotificationRead(notificationId) {
    if (!this.socket) {
      throw new Error('Not connected to WebSocket server');
    }

    this.socket.emit('ack_notification', { notificationId });
  }

  // Disconnect from server
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // Handle new comment (implement your business logic)
  handleNewComment(comment) {
    // Example: Send email notification, update database, etc.
    console.log('Processing new comment:', comment.id);
    
    // You might want to:
    // 1. Store the comment in your main database
    // 2. Send email notifications to subscribers
    // 3. Update any cached data
    // 4. Trigger webhooks
  }

  // Handle notification (implement your business logic)
  handleNotification(notification) {
    console.log('Processing notification:', notification.id);
    
    // You might want to:
    // 1. Display in your main UI
    // 2. Send push notifications
    // 3. Update notification counters
    // 4. Store in your database
  }
}

// Example usage in your main application
async function integrationExample() {
  const wsClient = new WebSocketClient(
    'http://localhost:3001',
    'your-jwt-secret-key'
  );

  // Sample user object (from your authentication system)
  const user = {
    id: '12345',
    username: 'johnsmith',
    email: 'john@example.com',
    displayName: 'John Smith',
    avatarUrl: 'https://example.com/avatar.jpg',
    role: 'user'
  };

  try {
    // Connect to WebSocket server
    await wsClient.connect(user);

    // Join a comment thread
    const comments = await wsClient.joinThread('post-123', 'post');
    console.log('Existing comments:', comments);

    // Create a new comment
    await wsClient.createComment(
      'post-123',
      'post',
      'This is a test comment from the integration!'
    );

    // Get user notifications
    const notifications = await wsClient.getNotifications();
    console.log('User notifications:', notifications);

    // Keep connection alive
    setTimeout(() => {
      wsClient.disconnect();
      console.log('Integration example completed');
    }, 5000);

  } catch (error) {
    console.error('Integration example failed:', error);
  }
}

// Express.js middleware example for generating WebSocket tokens
function createWebSocketMiddleware(jwtSecret) {
  return (req, res, next) => {
    if (req.user) {
      const wsToken = jwt.sign({
        userId: req.user.id,
        username: req.user.username,
        email: req.user.email,
        name: req.user.displayName,
        avatar: req.user.avatarUrl,
        role: req.user.role || 'user'
      }, jwtSecret, {
        expiresIn: '24h'
      });

      // Add WebSocket token to response locals
      res.locals.wsToken = wsToken;
    }
    next();
  };
}

// API endpoint example for getting WebSocket token
function createWebSocketTokenEndpoint(jwtSecret) {
  return (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const wsToken = jwt.sign({
      userId: req.user.id,
      username: req.user.username,
      email: req.user.email,
      name: req.user.displayName,
      avatar: req.user.avatarUrl,
      role: req.user.role || 'user'
    }, jwtSecret, {
      expiresIn: '24h'
    });

    res.json({ token: wsToken });
  };
}

// Database integration example
class DatabaseIntegration {
  constructor(wsClient, database) {
    this.wsClient = wsClient;
    this.db = database;
  }

  // Sync comments from WebSocket to database
  async syncComment(comment) {
    try {
      await this.db.comments.create({
        id: comment.id,
        threadId: comment.threadId,
        threadType: comment.threadType,
        content: comment.content,
        userId: comment.userId,
        parentId: comment.parentId,
        createdAt: new Date(comment.createdAt),
        updatedAt: new Date(comment.updatedAt)
      });

      console.log('Comment synced to database:', comment.id);
    } catch (error) {
      console.error('Failed to sync comment:', error);
    }
  }

  // Trigger notifications for comment mentions
  async handleCommentMentions(comment) {
    const mentions = this.extractMentions(comment.content);
    
    for (const username of mentions) {
      const user = await this.db.users.findByUsername(username);
      if (user) {
        // Send notification via WebSocket server or your notification system
        console.log(`Notifying ${username} about mention in comment ${comment.id}`);
      }
    }
  }

  extractMentions(content) {
    const mentionRegex = /@(\w+)/g;
    const mentions = [];
    let match;

    while ((match = mentionRegex.exec(content)) !== null) {
      mentions.push(match[1]);
    }

    return mentions;
  }
}

// Export classes and functions for use in your application
module.exports = {
  WebSocketClient,
  createWebSocketMiddleware,
  createWebSocketTokenEndpoint,
  DatabaseIntegration,
  integrationExample
};

// Run the example if this file is executed directly
if (require.main === module) {
  integrationExample();
} 