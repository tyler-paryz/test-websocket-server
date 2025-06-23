# WebSocket Server for Real-time Comments and Notifications

A standalone Node.js WebSocket server built with Socket.IO for managing real-time comments and notifications. This server is designed to be integrated with larger applications that need real-time communication capabilities.

## Features

- **Real-time Comments**: Create, update, delete, and view comments with threading support
- **Live Notifications**: Instant notifications for comment activity
- **Authentication**: JWT-based authentication for secure connections
- **Rate Limiting**: Built-in rate limiting to prevent abuse
- **Typing Indicators**: Show when users are typing in comment threads
- **Thread Management**: Support for multiple thread types (posts, articles, discussions, tasks)
- **Comment Reactions**: Like/dislike functionality for comments
- **Soft Deletes**: Comments are soft-deleted to maintain thread integrity
- **Comprehensive Logging**: Winston-based logging with rotation
- **Health Monitoring**: Health check endpoint for monitoring

## Quick Start

### 1. Installation

```bash
# Clone or copy the server files
npm install
```

### 2. Environment Setup

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### 3. Start the Server

```bash
# Development mode with auto-restart
npm run dev

# Production mode
npm start
```

The server will start on port 3001 by default and be accessible at `http://localhost:3001`.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `NODE_ENV` | development | Environment mode |
| `CORS_ORIGIN` | http://localhost:3000 | Allowed CORS origin |
| `JWT_SECRET` | (required) | JWT signing secret |
| `JWT_EXPIRES_IN` | 24h | JWT token expiration |
| `RATE_LIMIT_WINDOW_MS` | 900000 | Rate limiting window (15 mins) |
| `RATE_LIMIT_MAX_REQUESTS` | 100 | Max requests per window |
| `LOG_LEVEL` | info | Logging level |

## API Reference

### Socket.IO Events

#### Client → Server Events

| Event | Data | Description |
|-------|------|-------------|
| `join_thread` | `{threadId, threadType}` | Join a comment thread |
| `leave_thread` | `{threadId, threadType}` | Leave a comment thread |
| `new_comment` | `{threadId, threadType, content, parentId?}` | Create a new comment |
| `update_comment` | `{commentId, content}` | Update existing comment |
| `delete_comment` | `{commentId}` | Delete a comment |
| `get_notifications` | - | Get unread notifications |
| `ack_notification` | `{notificationId}` | Mark notification as read |
| `typing_start` | `{threadId, threadType}` | Start typing indicator |
| `typing_stop` | `{threadId, threadType}` | Stop typing indicator |

#### Server → Client Events

| Event | Data | Description |
|-------|------|-------------|
| `thread_comments` | `{threadId, threadType, comments[]}` | Initial comments for thread |
| `comment_added` | `{comment}` | New comment in thread |
| `comment_updated` | `{comment}` | Comment was updated |
| `comment_deleted` | `{commentId}` | Comment was deleted |
| `notifications` | `{notifications[]}` | User's notifications |
| `user_typing` | `{userId, userInfo, threadId, threadType}` | User started typing |
| `user_stopped_typing` | `{userId, threadId, threadType}` | User stopped typing |
| `error` | `{message, details?}` | Error occurred |

### HTTP Endpoints

- `GET /health` - Health check endpoint

## Integration Guide

### Frontend Integration

#### 1. Install Socket.IO Client

```bash
npm install socket.io-client
```

#### 2. Connect to Server

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3001', {
  auth: {
    token: 'your-jwt-token-here'
  }
});

// Handle connection
socket.on('connect', () => {
  console.log('Connected to WebSocket server');
});

socket.on('disconnect', () => {
  console.log('Disconnected from WebSocket server');
});
```

#### 3. Join a Comment Thread

```javascript
// Join a thread to receive real-time updates
socket.emit('join_thread', {
  threadId: 'post-123',
  threadType: 'post'
});

// Listen for existing comments
socket.on('thread_comments', (data) => {
  const { threadId, threadType, comments } = data;
  // Display comments in your UI
});
```

#### 4. Create Comments

```javascript
// Create a new comment
socket.emit('new_comment', {
  threadId: 'post-123',
  threadType: 'post',
  content: 'This is my comment!',
  parentId: null // or parent comment ID for replies
});

// Listen for new comments
socket.on('comment_added', (comment) => {
  // Add comment to your UI
});
```

#### 5. Handle Notifications

```javascript
// Get notifications on connect
socket.emit('get_notifications');

socket.on('notifications', (notifications) => {
  // Display notifications in your UI
});

// Mark notification as read
socket.emit('ack_notification', {
  notificationId: 'notification-id'
});
```

### Backend Integration

#### JWT Token Generation

Your main application needs to generate JWT tokens for authentication:

```javascript
const jwt = require('jsonwebtoken');

function generateWebSocketToken(user) {
  return jwt.sign({
    userId: user.id,
    username: user.username,
    email: user.email,
    name: user.displayName,
    avatar: user.avatarUrl,
    role: user.role
  }, process.env.JWT_SECRET, {
    expiresIn: '24h'
  });
}

// When user logs in, provide this token to frontend
const wsToken = generateWebSocketToken(user);
```

#### Database Integration

Replace the in-memory storage with your database:

```javascript
// In services/CommentManager.js
async createComment(commentData) {
  // Replace with your database call
  const comment = await db.comments.create({
    threadId: commentData.threadId,
    threadType: commentData.threadType,
    content: commentData.content,
    userId: commentData.userId,
    parentId: commentData.parentId
  });
  
  return comment;
}
```

### Scaling Considerations

For production deployments:

1. **Database**: Replace in-memory storage with Redis or PostgreSQL
2. **Clustering**: Use Redis adapter for Socket.IO clustering
3. **Load Balancing**: Configure sticky sessions for load balancers
4. **Monitoring**: Implement metrics and health checks
5. **Security**: Use HTTPS and validate all inputs

#### Redis Adapter Setup

```javascript
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');

const pubClient = createClient({ url: 'redis://localhost:6379' });
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
  io.adapter(createAdapter(pubClient, subClient));
});
```

## Error Handling

The server includes comprehensive error handling:

- **Authentication errors**: Invalid or expired tokens
- **Validation errors**: Invalid data format or missing fields
- **Rate limiting**: Too many requests from a client
- **Authorization errors**: Insufficient permissions
- **Network errors**: Connection issues

## Logging

Logs are written to:
- `logs/error.log` - Error-level logs only
- `logs/combined.log` - All logs
- Console output in development mode

## Thread Types

The server supports different thread types:
- `post` - Blog posts or social media posts
- `article` - News articles or documentation
- `discussion` - Forum discussions
- `task` - Project tasks or issues

You can extend this by modifying the validation schemas in `server.js`.

## Security Features

- JWT authentication for all connections
- Rate limiting to prevent spam
- Input validation using Joi schemas
- CORS protection
- Helmet.js security headers
- Comprehensive audit logging

## Development

### Running Tests

```bash
npm test
```

### Code Structure

```
├── server.js              # Main server file
├── services/
│   ├── CommentManager.js   # Comment operations
│   └── NotificationManager.js # Notification handling
├── middleware/
│   └── auth.js            # Authentication middleware
├── utils/
│   └── logger.js          # Winston logger configuration
├── logs/                  # Log files
├── package.json
├── .env                   # Environment variables
└── README.md
```

## Contributing

1. Follow the existing code style
2. Add tests for new features
3. Update documentation
4. Ensure all tests pass

## License

MIT License - see LICENSE file for details. 