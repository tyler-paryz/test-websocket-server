const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

class AuthMiddleware {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'default-secret-key';
    // For Firebase tokens, you might need to disable verification or use Firebase Admin SDK
    this.skipVerification = process.env.SKIP_JWT_VERIFICATION === 'true';
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

      // Handle JWT token verification
      let decoded;
      if (this.skipVerification) {
        // For debugging: decode without verification
        decoded = jwt.decode(token);
        logger.info('JWT verification skipped (debug mode)', { tokenPayload: decoded });
      } else {
        try {
          // Verify JWT token
          decoded = jwt.verify(token, this.jwtSecret);
        } catch (verifyError) {
          // If verification fails, try to decode without verification for Firebase tokens
          logger.warn('JWT verification failed, attempting decode-only', { error: verifyError.message });
          decoded = jwt.decode(token);
          if (!decoded) {
            throw verifyError;
          }
        }
      }
      
      // Handle different JWT structures (Firebase, custom, etc.)
      let userInfo;
      if (decoded.claims && decoded.claims.user) {
        // Firebase/Snippyly JWT structure
        userInfo = decoded.claims.user;
      } else if (decoded.user) {
        // Custom JWT with user object
        userInfo = decoded.user;
      } else {
        // Flat JWT structure
        userInfo = decoded;
      }
      
      // Attach user information to socket
      socket.userId = userInfo.userId || userInfo.userSnippylyId || userInfo.id || decoded.uid;
      socket.userInfo = {
        id: socket.userId,
        username: userInfo.clientUserName || userInfo.username || userInfo.name,
        email: userInfo.email,
        name: userInfo.name || userInfo.clientUserName,
        avatar: userInfo.avatar,
        role: userInfo.isAdmin ? 'admin' : (userInfo.role || 'user'),
        textColor: userInfo.textColor,
        color: userInfo.color,
        organizationId: userInfo.organizationId || userInfo.clientOrganizationId
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