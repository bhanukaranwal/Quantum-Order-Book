use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq)]
pub enum OrderSide {
    Bid,
    Ask,
}

#[derive(Debug, Clone)]
pub struct Order {
    pub id: String,
    pub price: f64,
    pub quantity: f64,
    pub side: OrderSide,
    pub venue: String,
    pub symbol: String,
    pub timestamp: DateTime<Utc>,
    pub participant_type: Option<String>,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct OrderBookSnapshot {
    pub bids: Vec<PriceLevel>,
    pub asks: Vec<PriceLevel>,
    pub timestamp: DateTime<Utc>,
    pub venue: String,
    pub symbol: String,
}

#[derive(Debug, Clone)]
pub struct PriceLevel {
    pub price: f64,
    pub total_quantity: f64,
    pub order_count: usize,
}

#[derive(Debug)]
pub struct OrderBook {
    venue: String,
    symbol: String,
    bids: BTreeMap<i64, HashMap<String, Order>>,  // Price to Orders map (prices stored as integer for precise sorting)
    asks: BTreeMap<i64, HashMap<String, Order>>,  // Price to Orders map
    price_precision: u32,                         // Number of decimal places
    last_update_time: DateTime<Utc>,
}

impl OrderBook {
    pub fn new(venue: &str, symbol: &str, price_precision: u32) -> Self {
        OrderBook {
            venue: venue.to_string(),
            symbol: symbol.to_string(),
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            price_precision,
            last_update_time: Utc::now(),
        }
    }
    
    // Convert floating point price to integer representation for precise ordering
    fn price_to_key(&self, price: f64) -> i64 {
        let multiplier = 10_i64.pow(self.price_precision);
        (price * multiplier as f64).round() as i64
    }
    
    // Convert integer key back to floating point price
    fn key_to_price(&self, key: i64) -> f64 {
        let multiplier = 10_i64.pow(self.price_precision);
        key as f64 / multiplier as f64
    }
    
    pub fn add_order(&mut self, order: Order) -> Result<(), String> {
        let price_key = self.price_to_key(order.price);
        let orders_map = match order.side {
            OrderSide::Bid => &mut self.bids,
            OrderSide::Ask => &mut self.asks,
        };
        
        let orders_at_price = orders_map.entry(price_key).or_insert_with(HashMap::new);
        orders_at_price.insert(order.id.clone(), order);
        self.last_update_time = Utc::now();
        
        Ok(())
    }
    
    pub fn update_order(&mut self, order_id: &str, new_price: Option<f64>, new_quantity: Option<f64>) -> Result<(), String> {
        // Find the order first
        let order_opt = self.find_order(order_id);
        
        if let Some(order) = order_opt {
            // Remove existing order
            let price_key = self.price_to_key(order.price);
            let orders_map = match order.side {
                OrderSide::Bid => &mut self.bids,
                OrderSide::Ask => &mut self.asks,
            };
            
            if let Some(orders_at_price) = orders_map.get_mut(&price_key) {
                orders_at_price.remove(order_id);
                
                // Clean up empty price levels
                if orders_at_price.is_empty() {
                    orders_map.remove(&price_key);
                }
            }
            
            // Create updated order
            let mut updated_order = order.clone();
            if let Some(price) = new_price {
                updated_order.price = price;
            }
            if let Some(quantity) = new_quantity {
                updated_order.quantity = quantity;
            }
            updated_order.timestamp = Utc::now();
            
            // Add back the updated order
            self.add_order(updated_order)?;
            self.last_update_time = Utc::now();
            
            Ok(())
        } else {
            Err(format!("Order with ID {} not found", order_id))
        }
    }
    
    pub fn cancel_order(&mut self, order_id: &str) -> Result<(), String> {
        let order_opt = self.find_order(order_id);
        
        if let Some(order) = order_opt {
            let price_key = self.price_to_key(order.price);
            let orders_map = match order.side {
                OrderSide::Bid => &mut self.bids,
                OrderSide::Ask => &mut self.asks,
            };
            
            if let Some(orders_at_price) = orders_map.get_mut(&price_key) {
                orders_at_price.remove(order_id);
                
                // Clean up empty price levels
                if orders_at_price.is_empty() {
                    orders_map.remove(&price_key);
                }
                
                self.last_update_time = Utc::now();
                Ok(())
            } else {
                Err(format!("Price level not found for order {}", order_id))
            }
        } else {
            Err(format!("Order with ID {} not found", order_id))
        }
    }
    
    fn find_order(&self, order_id: &str) -> Option<Order> {
        // Search in bids
        for orders_at_price in self.bids.values() {
            if let Some(order) = orders_at_price.get(order_id) {
                return Some(order.clone());
            }
        }
        
        // Search in asks
        for orders_at_price in self.asks.values() {
            if let Some(order) = orders_at_price.get(order_id) {
                return Some(order.clone());
            }
        }
        
        None
    }
    
    pub fn get_snapshot(&self, depth: Option<usize>) -> OrderBookSnapshot {
        let max_levels = depth.unwrap_or(usize::MAX);
        
        // Get top bid levels (sorted in descending order)
        let mut bids = Vec::new();
        for (price_key, orders) in self.bids.iter().rev().take(max_levels) {
            let price = self.key_to_price(*price_key);
            let total_quantity = orders.values().map(|o| o.quantity).sum();
            let order_count = orders.len();
            
            bids.push(PriceLevel {
                price,
                total_quantity,
                order_count,
            });
        }
        
        // Get top ask levels (sorted in ascending order)
        let mut asks = Vec::new();
        for (price_key, orders) in self.asks.iter().take(max_levels) {
            let price = self.key_to_price(*price_key);
            let total_quantity = orders.values().map(|o| o.quantity).sum();
            let order_count = orders.len();
            
            asks.push(PriceLevel {
                price,
                total_quantity,
                order_count,
            });
        }
        
        OrderBookSnapshot {
            bids,
            asks,
            timestamp: self.last_update_time,
            venue: self.venue.clone(),
            symbol: self.symbol.clone(),
        }
    }
    
    pub fn get_mid_price(&self) -> Option<f64> {
        let best_bid = self.bids.iter().rev().next().map(|(k, _)| self.key_to_price(*k));
        let best_ask = self.asks.iter().next().map(|(k, _)| self.key_to_price(*k));
        
        match (best_bid, best_ask) {
            (Some(bid), Some(ask)) => Some((bid + ask) / 2.0),
            _ => None,
        }
    }
    
    pub fn get_spread(&self) -> Option<f64> {
        let best_bid = self.bids.iter().rev().next().map(|(k, _)| self.key_to_price(*k));
        let best_ask = self.asks.iter().next().map(|(k, _)| self.key_to_price(*k));
        
        match (best_bid, best_ask) {
            (Some(bid), Some(ask)) => Some(ask - bid),
            _ => None,
        }
    }
    
    pub fn get_total_liquidity(&self, side: OrderSide) -> f64 {
        match side {
            OrderSide::Bid => self.bids.values()
                .flat_map(|orders| orders.values())
                .map(|order| order.quantity)
                .sum(),
            OrderSide::Ask => self.asks.values()
                .flat_map(|orders| orders.values())
                .map(|order| order.quantity)
                .sum(),
        }
    }
    
    pub fn get_order_count(&self, side: OrderSide) -> usize {
        match side {
            OrderSide::Bid => self.bids.values()
                .map(|orders| orders.len())
                .sum(),
            OrderSide::Ask => self.asks.values()
                .map(|orders| orders.len())
                .sum(),
        }
    }
}

// Thread-safe wrapper for the OrderBook
pub struct SharedOrderBook {
    inner: Arc<RwLock<OrderBook>>,
}

impl SharedOrderBook {
    pub fn new(venue: &str, symbol: &str, price_precision: u32) -> Self {
        SharedOrderBook {
            inner: Arc::new(RwLock::new(
                OrderBook::new(venue, symbol, price_precision)
            )),
        }
    }
    
    pub async fn add_order(&self, order: Order) -> Result<(), String> {
        let mut book = self.inner.write().await;
        book.add_order(order)
    }
    
    pub async fn update_order(&self, order_id: &str, new_price: Option<f64>, new_quantity: Option<f64>) -> Result<(), String> {
        let mut book = self.inner.write().await;
        book.update_order(order_id, new_price, new_quantity)
    }
    
    pub async fn cancel_order(&self, order_id: &str) -> Result<(), String> {
        let mut book = self.inner.write().await;
        book.cancel_order(order_id)
    }
    
    pub async fn get_snapshot(&self, depth: Option<usize>) -> OrderBookSnapshot {
        let book = self.inner.read().await;
        book.get_snapshot(depth)
    }
    
    pub async fn get_mid_price(&self) -> Option<f64> {
        let book = self.inner.read().await;
        book.get_mid_price()
    }
    
    pub async fn get_spread(&self) -> Option<f64> {
        let book = self.inner.read().await;
        book.get_spread()
    }
}