import express from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validation.middleware';
import { orderController } from '../controllers/order.controller';
import { marketDataController } from '../controllers/market-data.controller';
import { userController } from '../controllers/user.controller';
import { analyticsController } from '../controllers/analytics.controller';
import { exchangeController } from '../controllers/exchange.controller';
import { adminController } from '../controllers/admin.controller';
import { orderValidation } from '../validations/order.validation';
import { userValidation } from '../validations/user.validation';
import { checkPermission } from '../middleware/permission.middleware';

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Market data routes
router.get('/market-data/order-book/:venue/:symbol', rateLimit(), marketDataController.getOrderBook);
router.get('/market-data/trades/:venue/:symbol', rateLimit(), marketDataController.getTrades);
router.get('/market-data/candles/:venue/:symbol/:timeframe', rateLimit(), marketDataController.getCandles);
router.get('/market-data/symbols', rateLimit(), marketDataController.getSymbols);
router.get('/market-data/venues', rateLimit(), marketDataController.getVenues);
router.get('/market-data/ticker/:venue/:symbol', rateLimit(), marketDataController.getTicker);

// Order routes - require authentication
router.post(
  '/orders',
  authenticate(),
  rateLimit(),
  validate(orderValidation.createOrder),
  orderController.createOrder
);

router.get(
  '/orders',
  authenticate(),
  rateLimit(),
  orderController.getOrders
);

router.get(
  '/orders/:orderId',
  authenticate(),
  rateLimit(),
  orderController.getOrderById
);

router.delete(
  '/orders/:orderId',
  authenticate(),
  rateLimit(),
  orderController.cancelOrder
);

router.delete(
  '/orders',
  authenticate(),
  rateLimit(),
  validate(orderValidation.cancelAllOrders),
  orderController.cancelAllOrders
);

// User routes
router.post(
  '/auth/register',
  rateLimit(),
  validate(userValidation.register),
  userController.register
);

router.post(
  '/auth/login',
  rateLimit(),
  validate(userValidation.login),
  userController.login
);

router.post(
  '/auth/logout',
  authenticate(),
  rateLimit(),
  userController.logout
);

router.post(
  '/auth/refresh-token',
  rateLimit(),
  validate(userValidation.refreshToken),
  userController.refreshToken
);

router.get(
  '/user/profile',
  authenticate(),
  rateLimit(),
  userController.getProfile
);

router.put(
  '/user/profile',
  authenticate(),
  rateLimit(),
  validate(userValidation.updateProfile),
  userController.updateProfile
);

router.post(
  '/user/api-keys',
  authenticate(),
  rateLimit(),
  validate(userValidation.createApiKey),
  userController.createApiKey
);

router.get(
  '/user/api-keys',
  authenticate(),
  rateLimit(),
  userController.getApiKeys
);

router.delete(
  '/user/api-keys/:keyId',
  authenticate(),
  rateLimit(),
  userController.deleteApiKey
);

// Exchange integration routes
router.post(
  '/exchanges',
  authenticate(),
  rateLimit(),
  validate(userValidation.addExchange),
  exchangeController.addExchangeCredentials
);

router.get(
  '/exchanges',
  authenticate(),
  rateLimit(),
  exchangeController.getExchangeCredentials
);

router.delete(
  '/exchanges/:id',
  authenticate(),
  rateLimit(),
  exchangeController.deleteExchangeCredentials
);

router.post(
  '/exchanges/:id/test',
  authenticate(),
  rateLimit(),
  exchangeController.testExchangeCredentials
);

// Analytics routes
router.get(
  '/analytics/correlation/:symbol1/:symbol2',
  authenticate(),
  rateLimit(),
  analyticsController.getCorrelation
);

router.get(
  '/analytics/strategies',
  authenticate(),
  rateLimit(),
  analyticsController.getStrategies
);

router.post(
  '/analytics/strategies',
  authenticate(),
  rateLimit(),
  analyticsController.createStrategy
);

router.get(
  '/analytics/strategies/:id',
  authenticate(),
  rateLimit(),
  analyticsController.getStrategyById
);

router.put(
  '/analytics/strategies/:id',
  authenticate(),
  rateLimit(),
  analyticsController.updateStrategy
);

router.delete(
  '/analytics/strategies/:id',
  authenticate(),
  rateLimit(),
  analyticsController.deleteStrategy
);

router.post(
  '/analytics/strategies/:id/backtest',
  authenticate(),
  rateLimit(),
  analyticsController.backtestStrategy
);

// Admin routes - require admin permission
router.get(
  '/admin/users',
  authenticate(),
  checkPermission('admin:read_users'),
  adminController.getUsers
);

router.get(
  '/admin/users/:id',
  authenticate(),
  checkPermission('admin:read_users'),
  adminController.getUserById
);

router.put(
  '/admin/users/:id',
  authenticate(),
  checkPermission('admin:update_users'),
  adminController.updateUser
);

router.post(
  '/admin/users/:id/suspend',
  authenticate(),
  checkPermission('admin:suspend_users'),
  adminController.suspendUser
);

router.post(
  '/admin/circuit-breakers',
  authenticate(),
  checkPermission('admin:manage_circuit_breakers'),
  adminController.createCircuitBreaker
);

router.get(
  '/admin/circuit-breakers',
  authenticate(),
  checkPermission('admin:read_circuit_breakers'),
  adminController.getCircuitBreakers
);

router.put(
  '/admin/circuit-breakers/:id',
  authenticate(),
  checkPermission('admin:manage_circuit_breakers'),
  adminController.updateCircuitBreaker
);

export default router;