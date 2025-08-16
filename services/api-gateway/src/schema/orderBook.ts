import { gql } from 'apollo-server-express';
import { OrderBookService } from '../services/OrderBookService';
import { pubsub } from '../pubsub';

export const ORDER_BOOK_UPDATED = 'ORDER_BOOK_UPDATED';

export const typeDefs = gql`
  type PriceLevel {
    price: Float!
    quantity: Float!
    total: Float!
    orderCount: Int!
  }

  type OrderBookSide {
    levels: [PriceLevel!]!
    totalQuantity: Float!
    totalOrders: Int!
  }

  type OrderBook {
    venue: String!
    symbol: String!
    timestamp: Float!
    bids: OrderBookSide!
    asks: OrderBookSide!
    spread: Float
    midPrice: Float
  }

  extend type Query {
    orderBook(venue: String!, symbol: String!, depth: Int): OrderBook
    orderBooks(venues: [String!]!, symbol: String!, depth: Int): [OrderBook!]!
  }

  extend type Subscription {
    orderBookUpdates(venues: [String!]!, symbol: String!): OrderBook!
  }
`;

export const resolvers = {
  Query: {
    orderBook: async (_, { venue, symbol, depth }, { dataSources }) => {
      const orderBookService = new OrderBookService();
      return orderBookService.getOrderBook(venue, symbol, depth);
    },
    orderBooks: async (_, { venues, symbol, depth }, { dataSources }) => {
      const orderBookService = new OrderBookService();
      return Promise.all(
        venues.map(venue => orderBookService.getOrderBook(venue, symbol, depth))
      );
    }
  },
  Subscription: {
    orderBookUpdates: {
      subscribe: (_, { venues, symbol }) => {
        // Subscribe to Redis channel or other message bus for real-time updates
        venues.forEach(venue => {
          const channel = `orderbook.${venue.toLowerCase()}.${symbol.toLowerCase()}`;
          // Set up subscription logic here - simplified for example
        });
        
        return pubsub.asyncIterator([ORDER_BOOK_UPDATED]);
      }
    }
  }
};