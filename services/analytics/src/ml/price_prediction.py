import numpy as np
import pandas as pd
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import LSTM, Dense, Dropout
from sklearn.preprocessing import MinMaxScaler
import redis
import json
import logging
from datetime import datetime, timedelta

class PricePredictionModel:
    def __init__(self, redis_client, model_path=None):
        self.logger = logging.getLogger("PricePredictionModel")
        self.redis_client = redis_client
        self.scaler = MinMaxScaler(feature_range=(0, 1))
        self.model = self._build_model() if model_path is None else self._load_model(model_path)
        self.sequence_length = 60  # Use 60 time steps of data to predict next price
        
    def _build_model(self):
        """Build a new LSTM model for price prediction"""
        model = Sequential()
        model.add(LSTM(units=50, return_sequences=True, input_shape=(self.sequence_length, 5)))
        model.add(Dropout(0.2))
        model.add(LSTM(units=50, return_sequences=True))
        model.add(Dropout(0.2))
        model.add(LSTM(units=50))
        model.add(Dropout(0.2))
        model.add(Dense(units=1))
        
        model.compile(optimizer='adam', loss='mean_squared_error')
        self.logger.info("Built new LSTM model for price prediction")
        return model
        
    def _load_model(self, path):
        """Load a saved model from disk"""
        try:
            model = tf.keras.models.load_model(path)
            self.logger.info(f"Loaded model from {path}")
            return model
        except Exception as e:
            self.logger.error(f"Error loading model: {e}")
            return self._build_model()
    
    def save_model(self, path):
        """Save the current model to disk"""
        try:
            self.model.save(path)
            self.logger.info(f"Model saved to {path}")
            return True
        except Exception as e:
            self.logger.error(f"Error saving model: {e}")
            return False
    
    def fetch_training_data(self, venue, symbol, lookback_days=30):
        """Fetch historical data for training from Redis or database"""
        try:
            # In a real implementation, this would retrieve data from a time-series database
            # For this example, we'll simulate fetching from Redis
            
            end_time = datetime.now()
            start_time = end_time - timedelta(days=lookback_days)
            
            # Format timestamps as Redis keys
            start_key = int(start_time.timestamp() * 1000)
            end_key = int(end_time.timestamp() * 1000)
            
            # In production, use a time-series database or optimized Redis query
            # This is a simplified example
            data_key = f"orderbook:{venue.lower()}:{symbol.lower()}:summary"
            raw_data = self.redis_client.zrangebyscore(data_key, start_key, end_key)
            
            if not raw_data:
                self.logger.warning(f"No data found for {venue}:{symbol} in the last {lookback_days} days")
                return None
            
            # Parse the data
            parsed_data = []
            for item in raw_data:
                record = json.loads(item)
                parsed_data.append({
                    'timestamp': record['timestamp'],
                    'price': record['price'],
                    'volume': record['volume'],
                    'bid_ask_spread': record['ask_price'] - record['bid_price'],
                    'mid_price': (record['ask_price'] + record['bid_price']) / 2,
                    'imbalance': record['bid_volume'] / (record['bid_volume'] + record['ask_volume'])
                })
            
            return pd.DataFrame(parsed_data)
            
        except Exception as e:
            self.logger.error(f"Error fetching training data: {e}")
            return None
    
    def prepare_data(self, df):
        """Prepare the data for training or prediction"""
        # Select features
        data = df[['price', 'volume', 'bid_ask_spread', 'mid_price', 'imbalance']].values
        
        # Scale the data
        scaled_data = self.scaler.fit_transform(data)
        
        X, y = [], []
        for i in range(self.sequence_length, len(scaled_data)):
            X.append(scaled_data[i-self.sequence_length:i])
            y.append(scaled_data[i, 0])  # 0 is the price column
            
        return np.array(X), np.array(y)
    
    def train(self, venue, symbol, epochs=50, batch_size=32):
        """Train the model on historical data"""
        df = self.fetch_training_data(venue, symbol)
        if df is None or len(df) < self.sequence_length + 10:
            self.logger.error(f"Insufficient data to train model for {venue}:{symbol}")
            return False
        
        X, y = self.prepare_data(df)
        
        # Split into training and validation sets (80/20)
        split_idx = int(len(X) * 0.8)
        X_train, X_val = X[:split_idx], X[split_idx:]
        y_train, y_val = y[:split_idx], y[split_idx:]
        
        # Train the model
        try:
            history = self.model.fit(
                X_train, y_train,
                epochs=epochs,
                batch_size=batch_size,
                validation_data=(X_val, y_val),
                verbose=1
            )
            
            # Save training metrics
            training_metrics = {
                'venue': venue,
                'symbol': symbol,
                'loss': float(history.history['loss'][-1]),
                'val_loss': float(history.history['val_loss'][-1]),
                'timestamp': datetime.now().isoformat(),
                'data_points': len(X)
            }
            
            metrics_key = f"ml:training:metrics:{venue.lower()}:{symbol.lower()}"
            self.redis_client.set(metrics_key, json.dumps(training_metrics))
            
            self.logger.info(f"Model trained successfully for {venue}:{symbol}")
            return True
            
        except Exception as e:
            self.logger.error(f"Error training model: {e}")
            return False
    
    def predict_next(self, venue, symbol, time_horizon_minutes=5):
        """Predict price movement for the next n minutes"""
        try:
            # Get the most recent data
            recent_data = self.fetch_training_data(venue, symbol, lookback_days=1)
            if recent_data is None or len(recent_data) < self.sequence_length:
                self.logger.error(f"Insufficient recent data for prediction")
                return None
            
            # Prepare the data
            recent_data = recent_data.tail(self.sequence_length)
            data = recent_data[['price', 'volume', 'bid_ask_spread', 'mid_price', 'imbalance']].values
            scaled_data = self.scaler.transform(data)
            
            # Reshape for prediction
            X = np.array([scaled_data])
            
            # Make prediction
            predicted_scaled = self.model.predict(X)
            predicted_price = self.scaler.inverse_transform(
                np.hstack([predicted_scaled, np.zeros((predicted_scaled.shape[0], 4))])
            )[:, 0][0]
            
            current_price = recent_data['price'].iloc[-1]
            price_change = predicted_price - current_price
            percent_change = (price_change / current_price) * 100
            
            prediction = {
                'venue': venue,
                'symbol': symbol,
                'current_price': float(current_price),
                'predicted_price': float(predicted_price),
                'price_change': float(price_change),
                'percent_change': float(percent_change),
                'prediction_time': datetime.now().isoformat(),
                'time_horizon_minutes': time_horizon_minutes,
                'confidence': self._calculate_confidence(percent_change)
            }
            
            # Store the prediction
            prediction_key = f"ml:predictions:{venue.lower()}:{symbol.lower()}"
            self.redis_client.set(prediction_key, json.dumps(prediction))
            self.redis_client.expire(prediction_key, 60 * time_horizon_minutes)  # Expire after time horizon
            
            return prediction
            
        except Exception as e:
            self.logger.error(f"Error making prediction: {e}")
            return None
    
    def _calculate_confidence(self, percent_change):
        """Calculate a confidence score for the prediction"""
        # This would be more sophisticated in a real system
        # Here we're just using a simple heuristic based on the magnitude of change
        abs_change = abs(percent_change)
        if abs_change > 5.0:
            return 'low'  # Very large changes are less likely
        elif abs_change > 2.0:
            return 'medium'
        else:
            return 'high'  # Small changes are more likely to be accurate

# Example usage
if __name__ == "__main__":
    # Setup Redis connection
    r = redis.Redis(host='localhost', port=6379, db=0)
    
    # Initialize model
    model = PricePredictionModel(r)
    
    # Train on historical data
    model.train('BINANCE', 'BTC-USDT')
    
    # Make a prediction
    prediction = model.predict_next('BINANCE', 'BTC-USDT')
    print(prediction)