import React, { useState, useEffect, useCallback } from 'react';
import { Card } from '../common/Card';
import { Spinner } from '../common/Spinner';
import { Button } from '../common/Button';
import { Badge } from '../common/Badge';
import { Dropdown } from '../common/Dropdown';
import { Icon } from '../common/Icon';
import { formatTime, formatPrice, formatQuantity } from '../../utils/formatters';
import { useAnalyticsApi } from '../../hooks/useAnalyticsApi';

interface TradeFlowInsight {
  id: string;
  timestamp: string;
  type: 'pattern' | 'anomaly' | 'prediction' | 'summary';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  details?: {
    priceLevel?: number;
    quantity?: number;
    direction?: 'bullish' | 'bearish' | 'neutral';
    confidence?: number;
    relatedEvents?: Array<{
      time: string;
      description: string;
    }>;
    chart?: {
      dataType: string;
      data: any[];
    };
  };
  relatedSymbols?: string[];
  actions?: Array<{
    label: string;
    action: string;
    params?: any;
  }>;
}

interface NLTradeFlowAnalysisProps {
  symbol: string;
  venue: string;
  timeframe?: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  maxInsights?: number;
  onAction?: (action: string, params: any) => void;
  refreshInterval?: number;
}

export const NLTradeFlowAnalysis: React.FC<NLTradeFlowAnalysisProps> = ({
  symbol,
  venue,
  timeframe = '15m',
  maxInsights = 5,
  onAction,
  refreshInterval = 60000
}) => {
  const [insights, setInsights] = useState<TradeFlowInsight[]>([]);
  const [activeInsight, setActiveInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [filter, setFilter] = useState<string>('all');
  const { getTradeFlowAnalysis } = useAnalyticsApi();
  
  // Fetch trade flow insights
  const fetchInsights = useCallback(async () => {
    try {
      setRefreshing(true);
      
      const data = await getTradeFlowAnalysis({
        symbol,
        venue,
        timeframe,
        maxResults: maxInsights
      });
      
      setInsights(data);
      
      // Set the first insight as active if none is selected
      if (!activeInsight && data.length > 0) {
        setActiveInsight(data[0].id);
      }
      
      setError(null);
    } catch (err) {
      setError(`Failed to fetch trade flow analysis: ${err.message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [symbol, venue, timeframe, maxInsights, activeInsight, getTradeFlowAnalysis]);
  
  // Initial fetch
  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);
  
  // Set up auto-refresh
  useEffect(() => {
    if (!autoRefresh || refreshInterval <= 0) return;
    
    const intervalId = setInterval(() => {
      fetchInsights();
    }, refreshInterval);
    
    return () => clearInterval(intervalId);
  }, [autoRefresh, refreshInterval, fetchInsights]);
  
  // Get the active insight
  const getActiveInsightData = () => {
    if (!activeInsight) return null;
    return insights.find(insight => insight.id === activeInsight) || null;
  };
  
  // Handle action click
  const handleActionClick = (action: string, params: any) => {
    if (onAction) {
      onAction(action, params);
    }
  };
  
  // Filter insights
  const filteredInsights = React.useMemo(() => {
    if (filter === 'all') return insights;
    return insights.filter(insight => insight.type === filter);
  }, [insights, filter]);
  
  // Severity color
  const getSeverityColor = (severity: 'low' | 'medium' | 'high') => {
    switch (severity) {
      case 'low':
        return 'info';
      case 'medium':
        return 'warning';
      case 'high':
        return 'danger';
      default:
        return 'info';
    }
  };
  
  // Type icon
  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'pattern':
        return 'chart-line';
      case 'anomaly':
        return 'exclamation-triangle';
      case 'prediction':
        return 'crystal-ball';
      case 'summary':
        return 'clipboard-list';
      default:
        return 'info-circle';
    }
  };
  
  // Get current active insight
  const activeInsightData = getActiveInsightData();
  
  return (
    <Card className="nl-trade-flow-analysis">
      <div className="card-header">
        <h3 className="card-title">
          Trade Flow Analysis
          <Badge variant="primary" className="ml-2">AI</Badge>
        </h3>
        
        <div className="card-actions">
          <Dropdown
            label={`Filter: ${filter === 'all' ? 'All Types' : filter.charAt(0).toUpperCase() + filter.slice(1)}`}
            items={[
              { label: 'All Types', value: 'all' },
              { label: 'Patterns', value: 'pattern' },
              { label: 'Anomalies', value: 'anomaly' },
              { label: 'Predictions', value: 'prediction' },
              { label: 'Summaries', value: 'summary' }
            ]}
            onSelect={(value) => setFilter(value)}
          />
          
          <Button
            variant="secondary"
            size="small"
            onClick={fetchInsights}
            disabled={refreshing}
            icon={refreshing ? 'spinner' : 'refresh'}
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
          
          <Button
            variant={autoRefresh ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setAutoRefresh(!autoRefresh)}
            icon={autoRefresh ? 'clock' : 'clock-outline'}
          >
            {autoRefresh ? 'Auto-refresh On' : 'Auto-refresh Off'}
          </Button>
        </div>
      </div>
      
      <div className="card-content">
        {loading && !refreshing ? (
          <div className="loading-container">
            <Spinner size="large" />
            <p>Loading trade flow analysis...</p>
          </div>
        ) : error ? (
          <div className="error-container">
            <Icon name="exclamation-circle" size="large" color="danger" />
            <p>{error}</p>
            <Button variant="secondary" onClick={fetchInsights}>
              Try Again
            </Button>
          </div>
        ) : (
          <div className="insights-container">
            <div className="insights-list">
              {filteredInsights.length === 0 ? (
                <div className="empty-state">
                  <p>No insights available for the current filter.</p>
                </div>
              ) : (
                filteredInsights.map(insight => (
                  <div
                    key={insight.id}
                    className={`insight-item ${activeInsight === insight.id ? 'active' : ''}`}
                    onClick={() => setActiveInsight(insight.id)}
                  >
                    <div className="insight-icon">
                      <Icon
                        name={getTypeIcon(insight.type)}
                        color={getSeverityColor(insight.severity)}
                      />
                    </div>
                    
                    <div className="insight-content">
                      <h4 className="insight-title">{insight.title}</h4>
                      <div className="insight-meta">
                        <span className="insight-time">
                          {formatTime(new Date(insight.timestamp))}
                        </span>
                        <Badge
                          variant={getSeverityColor(insight.severity)}
                          size="small"
                        >
                          {insight.severity}
                        </Badge>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            
            <div className="insight-details">
              {activeInsightData ? (
                <>
                  <div className="insight-header">
                    <h3 className="insight-title">
                      <Icon
                        name={getTypeIcon(activeInsightData.type)}
                        color={getSeverityColor(activeInsightData.severity)}
                        className="mr-2"
                      />
                      {activeInsightData.title}
                    </h3>
                    <div className="insight-meta">
                      <span className="insight-time">
                        {formatTime(new Date(activeInsightData.timestamp))}
                      </span>
                      <Badge
                        variant={getSeverityColor(activeInsightData.severity)}
                      >
                        {activeInsightData.severity.toUpperCase()}
                      </Badge>
                    </div>
                  </div>
                  
                  <div className="insight-body">
                    <p className="insight-description">
                      {activeInsightData.description}
                    </p>
                    
                    {activeInsightData.details && (
                      <div className="insight-details-section">
                        {activeInsightData.details.priceLevel && (
                          <div className="detail-item">
                            <span className="detail-label">Price Level:</span>
                            <span className="detail-value">
                              {formatPrice(activeInsightData.details.priceLevel)}
                            </span>
                          </div>
                        )}
                        
                        {activeInsightData.details.quantity && (
                          <div className="detail-item">
                            <span className="detail-label">Quantity:</span>
                            <span className="detail-value">
                              {formatQuantity(activeInsightData.details.quantity)}
                            </span>
                          </div>
                        )}
                        
                        {activeInsightData.details.direction && (
                          <div className="detail-item">
                            <span className="detail-label">Direction:</span>
                            <span className={`detail-value ${activeInsightData.details.direction}`}>
                              {activeInsightData.details.direction.toUpperCase()}
                            </span>
                          </div>
                        )}
                        
                        {activeInsightData.details.confidence !== undefined && (
                          <div className="detail-item">
                            <span className="detail-label">Confidence:</span>
                            <span className="detail-value">
                              {(activeInsightData.details.confidence * 100).toFixed(1)}%
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {activeInsightData.details?.relatedEvents && activeInsightData.details.relatedEvents.length > 0 && (
                      <div className="related-events">
                        <h4>Related Events</h4>
                        <ul>
                          {activeInsightData.details.relatedEvents.map((event, index) => (
                            <li key={index}>
                              <span className="event-time">{formatTime(new Date(event.time))}</span>
                              <span className="event-description">{event.description}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    
                    {activeInsightData.relatedSymbols && activeInsightData.relatedSymbols.length > 0 && (
                      <div className="related-symbols">
                        <h4>Related Symbols</h4>
                        <div className="badge-container">
                          {activeInsightData.relatedSymbols.map(sym => (
                            <Badge
                              key={sym}
                              variant="secondary"
                              className="clickable"
                              onClick={() => handleActionClick('switch_symbol', { symbol: sym })}
                            >
                              {sym}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  
                  {activeInsightData.actions && activeInsightData.actions.length > 0 && (
                    <div className="insight-actions">
                      {activeInsightData.actions.map((action, index) => (
                        <Button
                          key={index}
                          variant="secondary"
                          onClick={() => handleActionClick(action.action, action.params)}
                          className="mr-2"
                        >
                          {action.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-state">
                  <p>Select an insight to view details</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};