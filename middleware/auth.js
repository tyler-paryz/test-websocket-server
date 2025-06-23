const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

class AuthMiddleware {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'default-secret-key';
  }

  // Socket.IO authentication middleware
  socketAuth = (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      
      if (!token) {
        logger.warn('Socket connection attempted without token', { 
          socketId: socket.id,
          ip: socket.handshake.address 
        });
        return next(new Error('Authentication required'));
      }

      // Verify JWT token
      const decoded = jwt.verify(token, this.jwtSecret);
      
      // Attach user information to socket
      socket.userId = decoded.userId || decoded.id;
      socket.userInfo = {
        id: socket.userId,
        username: decoded.username,
        email: decoded.email,
        name: decoded.name,
        avatar: decoded.avatar,
        role: decoded.role || 'user'
      };

      logger.info('Socket authenticated successfully', {
        socketId: socket.id,
        userId: socket.userId,
        username: decoded.username
      });

      next();
    } catch (error) {
      logger.warn('Socket authentication failed', {
        socketId: socket.id,
        error: error.message,
        ip: socket.handshake.address
      });
      
      if (error.name === 'TokenExpiredError') {
        next(new Error('Token expired'));
      } else if (error.name === 'JsonWebTokenError') {
        next(new Error('Invalid token'));
      } else {
        next(new Error('Authentication failed'));
      }
    }
  };

  // Express middleware for HTTP routes (if needed)
  httpAuth = (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

      if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const decoded = jwt.verify(token, this.jwtSecret);
      req.userId = decoded.userId || decoded.id;
      req.userInfo = {
        id: req.userId,
        username: decoded.username,
        email: decoded.email,
        name: decoded.name,
        avatar: decoded.avatar,
        role: decoded.role || 'user'
      };

      next();
    } catch (error) {
      logger.warn('HTTP authentication failed', {
        error: error.message,
        ip: req.ip
      });

      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Token expired' });
      } else if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({ error: 'Invalid token' });
      } else {
        return res.status(401).json({ error: 'Authentication failed' });
      }
    }
  };

  // Generate JWT token (utility method)
  generateToken = (userInfo, expiresIn = '24h') => {
    return jwt.sign(userInfo, this.jwtSecret, { expiresIn });
  };

  // Verify token (utility method)
  verifyToken = (token) => {
    return jwt.verify(token, this.jwtSecret);
  };

  // Check if user has required role
  requireRole = (requiredRole) => {
    return (socket, next) => {
      if (!socket.userInfo || !socket.userInfo.role) {
        return next(new Error('User role not found'));
      }

      const userRole = socket.userInfo.role;
      const roleHierarchy = {
        'user': 1,
        'moderator': 2,
        'admin': 3,
        'super_admin': 4
      };

      const userRoleLevel = roleHierarchy[userRole] || 0;
      const requiredRoleLevel = roleHierarchy[requiredRole] || 0;

      if (userRoleLevel < requiredRoleLevel) {
        logger.warn('Insufficient role for socket operation', {
          socketId: socket.id,
          userId: socket.userId,
          userRole,
          requiredRole
        });
        return next(new Error('Insufficient permissions'));
      }

      next();
    };
  };
}

module.exports = AuthMiddleware; 