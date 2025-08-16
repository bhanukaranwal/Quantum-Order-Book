                    label={`${(systemMetrics.memory.usage / systemMetrics.memory.capacity * 100).toFixed(1)}%`}
                    size={100}
                  />
                </div>
                <div className="metric">
                  <h4>Storage Usage</h4>
                  <GaugeChart 
                    value={systemMetrics.storage.usage}
                    min={0}
                    max={systemMetrics.storage.capacity}
                    thresholds={[
                      { value: 0, color: '#00C851' },
                      { value: systemMetrics.storage.capacity * 0.7, color: '#ffbb33' },
                      { value: systemMetrics.storage.capacity * 0.9, color: '#ff4444' }
                    ]}
                    label={`${(systemMetrics.storage.usage / systemMetrics.storage.capacity * 100).toFixed(1)}%`}
                    size={100}
                  />
                </div>
              </div>
            ) : (
              <div className="loading-container">
                <Spinner size="medium" />
              </div>
            )}
          </Card>
          
          <Card className="incidents-card">
            <h3>Active Incidents</h3>
            {incidents.length > 0 ? (
              <div className="incidents-list">
                {incidents.slice(0, 3).map(incident => (
                  <div key={incident.id} className={`incident-item severity-${incident.severity}`}>
                    <div className="incident-header">
                      <span className="incident-title">{incident.title}</span>
                      <span className={`incident-status status-${incident.status}`}>
                        {incident.status}
                      </span>
                    </div>
                    <div className="incident-time">
                      Started {formatTime(new Date(incident.startTime))}
                    </div>
                    <div className="affected-services">
                      {incident.affectedServices.join(', ')}
                    </div>
                  </div>
                ))}
                {incidents.length > 3 && (
                  <Button 
                    variant="text" 
                    onClick={() => setActiveTab('incidents')}
                  >
                    View all {incidents.length} incidents
                  </Button>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <p>No active incidents</p>
              </div>
            )}
          </Card>
          
          <Card className="alerts-card">
            <h3>Recent Alerts</h3>
            {alerts.length > 0 ? (
              <div className="alerts-list">
                {alerts.slice(0, 5).map(alert => (
                  <div key={alert.id} className={`alert-item severity-${alert.severity}`}>
                    <div className="alert-header">
                      <span className="alert-title">{alert.title}</span>
                      <span className="alert-time">{formatTime(new Date(alert.timestamp))}</span>
                    </div>
                    <div className="alert-source">{alert.source}</div>
                    {!alert.acknowledged && user?.hasPermission('ack_alerts') && (
                      <Button 
                        variant="text" 
                        size="small"
                        onClick={() => handleAcknowledgeAlert(alert.id)}
                      >
                        Acknowledge
                      </Button>
                    )}
                  </div>
                ))}
                {alerts.length > 5 && (
                  <Button 
                    variant="text" 
                    onClick={() => setActiveTab('alerts')}
                  >
                    View all {alerts.length} alerts
                  </Button>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <p>No recent alerts</p>
              </div>
            )}
          </Card>
        </div>
        
        <Card className="services-overview-card">
          <h3>Service Status</h3>
          <div className="services-table-container">
            <Table
              columns={[
                { key: 'status', label: 'Status', width: '80px' },
                { key: 'name', label: 'Service Name', width: '25%' },
                { key: 'uptime', label: 'Uptime', width: '15%' },
                { key: 'cpu', label: 'CPU', width: '15%' },
                { key: 'memory', label: 'Memory', width: '15%' },
                { key: 'responseTime', label: 'Response Time', width: '15%' },
                { key: 'actions', label: 'Actions', width: '10%' }
              ]}
              data={serviceStatuses.map(service => ({
                status: (
                  <StatusIndicator status={service.status} size="small" />
                ),
                name: service.name,
                uptime: service.uptime > 0 ? formatUptimeFromSeconds(service.uptime) : 'N/A',
                cpu: `${service.metrics.cpu.toFixed(1)}%`,
                memory: `${service.metrics.memory.toFixed(1)}%`,
                responseTime: `${service.metrics.responseTime.toFixed(0)}ms`,
                actions: (
                  <div className="actions-cell">
                    <Button
                      variant="icon"
                      icon="info-circle"
                      onClick={() => {
                        setSelectedService(service.id);
                        setActiveTab('services');
                      }}
                      title="View details"
                    />
                    {user?.hasPermission('restart_service') && (
                      <Button
                        variant="icon"
                        icon="refresh"
                        onClick={() => handleRestartService(service.id)}
                        title="Restart service"
                        disabled={service.details?.restarting}
                      />
                    )}
                  </div>
                )
              }))}
              rowClassName={(row, index) => {
                const service = serviceStatuses[index];
                if (service.status === 'down') return 'status-down';
                if (service.status === 'degraded') return 'status-degraded';
                return '';
              }}
              onRowClick={(row, index) => {
                setSelectedService(serviceStatuses[index].id);
                setActiveTab('services');
              }}
            />
          </div>
        </Card>
        
        <div className="charts-container">
          <Card className="cpu-chart-card">
            <h3>CPU Usage (24h)</h3>
            <LineChart
              data={metricsHistory.map(metric => ({
                timestamp: metric.timestamp,
                value: (metric.cpu.usage / metric.cpu.capacity) * 100
              }))}
              xKey="timestamp"
              yKey="value"
              xLabel="Time"
              yLabel="CPU Usage (%)"
              height={200}
              color="#4285F4"
              yDomain={[0, 100]}
              formatX={value => formatTime(new Date(value))}
              formatY={value => `${value.toFixed(1)}%`}
            />
          </Card>
          
          <Card className="memory-chart-card">
            <h3>Memory Usage (24h)</h3>
            <LineChart
              data={metricsHistory.map(metric => ({
                timestamp: metric.timestamp,
                value: (metric.memory.usage / metric.memory.capacity) * 100
              }))}
              xKey="timestamp"
              yKey="value"
              xLabel="Time"
              yLabel="Memory Usage (%)"
              height={200}
              color="#EA4335"
              yDomain={[0, 100]}
              formatX={value => formatTime(new Date(value))}
              formatY={value => `${value.toFixed(1)}%`}
            />
          </Card>
        </div>
      </div>
    );
  };
  
  // Render services tab
  const renderServicesTab = () => {
    // If a service is selected, show detailed view
    if (selectedService) {
      const service = serviceStatuses.find(s => s.id === selectedService);
      if (!service) {
        return (
          <div className="service-not-found">
            <p>Service not found</p>
            <Button variant="primary" onClick={() => setSelectedService(null)}>
              Back to Services
            </Button>
          </div>
        );
      }
      
      return (
        <div className="service-detail-view">
          <div className="service-detail-header">
            <Button 
              variant="text" 
              onClick={() => setSelectedService(null)}
              icon="arrow-left"
            >
              Back to Services
            </Button>
            <h2>{service.name}</h2>
            <StatusIndicator status={service.status} size="medium" showLabel={true} />
          </div>
          
          <div className="service-detail-cards">
            <Card className="service-info-card">
              <h3>Service Information</h3>
              <div className="info-grid">
                <div className="info-item">
                  <span className="info-label">ID:</span>
                  <span className="info-value">{service.id}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">Status:</span>
                  <span className="info-value">{service.status}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">Uptime:</span>
                  <span className="info-value">{formatUptimeFromSeconds(service.uptime)}</span>
                </div>
                <div className="info-item">
                  <span className="info-label">Last Checked:</span>
                  <span className="info-value">{formatTime(new Date(service.lastChecked))}</span>
                </div>
                {service.details?.version && (
                  <div className="info-item">
                    <span className="info-label">Version:</span>
                    <span className="info-value">{service.details.version}</span>
                  </div>
                )}
                {service.details?.deployTime && (
                  <div className="info-item">
                    <span className="info-label">Deployed:</span>
                    <span className="info-value">{formatTime(new Date(service.details.deployTime))}</span>
                  </div>
                )}
              </div>
              
              <div className="service-actions">
                {user?.hasPermission('restart_service') && (
                  <Button
                    variant="primary"
                    onClick={() => handleRestartService(service.id)}
                    disabled={service.details?.restarting}
                    icon="refresh"
                  >
                    {service.details?.restarting ? 'Restarting...' : 'Restart Service'}
                  </Button>
                )}
                {user?.hasPermission('view_logs') && (
                  <Button
                    variant="secondary"
                    icon="file-text"
                  >
                    View Logs
                  </Button>
                )}
              </div>
            </Card>
            
            <Card className="service-metrics-card">
              <h3>Current Metrics</h3>
              <div className="metrics-grid">
                <div className="metric-item">
                  <h4>CPU Usage</h4>
                  <GaugeChart 
                    value={service.metrics.cpu}
                    min={0}
                    max={100}
                    thresholds={[
                      { value: 0, color: '#00C851' },
                      { value: 70, color: '#ffbb33' },
                      { value: 90, color: '#ff4444' }
                    ]}
                    label={`${service.metrics.cpu.toFixed(1)}%`}
                    size={100}
                  />
                </div>
                <div className="metric-item">
                  <h4>Memory Usage</h4>
                  <GaugeChart 
                    value={service.metrics.memory}
                    min={0}
                    max={100}
                    thresholds={[
                      { value: 0, color: '#00C851' },
                      { value: 70, color: '#ffbb33' },
                      { value: 90, color: '#ff4444' }
                    ]}
                    label={`${service.metrics.memory.toFixed(1)}%`}
                    size={100}
                  />
                </div>
                <div className="metric-item">
                  <h4>Request Rate</h4>
                  <div className="value-display">
                    {service.metrics.requestRate.toFixed(2)} req/s
                  </div>
                </div>
                <div className="metric-item">
                  <h4>Error Rate</h4>
                  <div className="value-display">
                    {service.metrics.errorRate.toFixed(2)}%
                  </div>
                </div>
                <div className="metric-item">
                  <h4>Response Time</h4>
                  <div className="value-display">
                    {service.metrics.responseTime.toFixed(0)} ms
                  </div>
                </div>
              </div>
            </Card>
          </div>
          
          {service.details?.metrics && (
            <div className="service-charts">
              <Card className="request-chart">
                <h3>Request Rate (24h)</h3>
                <LineChart
                  data={service.details.metrics.requestRate}
                  xKey="timestamp"
                  yKey="value"
                  xLabel="Time"
                  yLabel="Requests/s"
                  height={200}
                  color="#4285F4"
                  formatX={value => formatTime(new Date(value))}
                  formatY={value => `${value.toFixed(2)}/s`}
                />
              </Card>
              
              <Card className="error-chart">
                <h3>Error Rate (24h)</h3>
                <LineChart
                  data={service.details.metrics.errorRate}
                  xKey="timestamp"
                  yKey="value"
                  xLabel="Time"
                  yLabel="Error Rate (%)"
                  height={200}
                  color="#EA4335"
                  yDomain={[0, 100]}
                  formatX={value => formatTime(new Date(value))}
                  formatY={value => `${value.toFixed(2)}%`}
                />
              </Card>
              
              <Card className="response-chart">
                <h3>Response Time (24h)</h3>
                <LineChart
                  data={service.details.metrics.responseTime}
                  xKey="timestamp"
                  yKey="value"
                  xLabel="Time"
                  yLabel="Response Time (ms)"
                  height={200}
                  color="#FBBC05"
                  formatX={value => formatTime(new Date(value))}
                  formatY={value => `${value.toFixed(0)} ms`}
                />
              </Card>
            </div>
          )}
          
          {service.details?.dependencies && (
            <Card className="dependencies-card">
              <h3>Dependencies</h3>
              <div className="dependencies-grid">
                {service.details.dependencies.map(dep => (
                  <div key={dep.id} className="dependency-item">
                    <div className="dependency-name">{dep.name}</div>
                    <StatusIndicator status={dep.status} size="small" />
                    {serviceStatuses.some(s => s.id === dep.id) && (
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => setSelectedService(dep.id)}
                      >
                        View
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
          
          {service.details?.incidents && service.details.incidents.length > 0 && (
            <Card className="service-incidents-card">
              <h3>Recent Incidents</h3>
              <div className="service-incidents-list">
                {service.details.incidents.map(incident => (
                  <div key={incident.id} className={`incident-item severity-${incident.severity}`}>
                    <div className="incident-header">
                      <span className="incident-title">{incident.title}</span>
                      <span className={`incident-status status-${incident.status}`}>
                        {incident.status}
                      </span>
                    </div>
                    <div className="incident-time">
                      {incident.startTime && (
                        <span>
                          Started {formatTime(new Date(incident.startTime))}
                        </span>
                      )}
                      {incident.endTime && (
                        <span>
                          Ended {formatTime(new Date(incident.endTime))}
                        </span>
                      )}
                    </div>
                    <div className="incident-description">
                      {incident.description}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      );
    }
    
    // Otherwise show list of all services
    return (
      <div className="services-tab">
        <div className="services-header">
          <h2>Services</h2>
          <div className="services-filters">
            <Button
              variant="text"
              className={`filter-btn ${serviceFilter === 'all' ? 'active' : ''}`}
              onClick={() => setServiceFilter('all')}
            >
              All
            </Button>
            <Button
              variant="text"
              className={`filter-btn ${serviceFilter === 'critical' ? 'active' : ''}`}
              onClick={() => setServiceFilter('critical')}
            >
              Critical Only
            </Button>
            <Button
              variant="text"
              className={`filter-btn ${serviceFilter === 'degraded' ? 'active' : ''}`}
              onClick={() => setServiceFilter('degraded')}
            >
              Degraded
            </Button>
          </div>
        </div>
        
        <div className="services-grid">
          {filteredServices.map(service => (
            <Card 
              key={service.id} 
              className={`service-card status-${service.status}`}
              onClick={() => setSelectedService(service.id)}
            >
              <div className="service-card-header">
                <h3>{service.name}</h3>
                <StatusIndicator status={service.status} size="medium" />
              </div>
              <div className="service-metrics">
                <div className="metric">
                  <span className="metric-label">CPU</span>
                  <span className="metric-value">{service.metrics.cpu.toFixed(1)}%</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Memory</span>
                  <span className="metric-value">{service.metrics.memory.toFixed(1)}%</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Error Rate</span>
                  <span className="metric-value">{service.metrics.errorRate.toFixed(2)}%</span>
                </div>
              </div>
              <div className="service-uptime">
                Uptime: {formatUptimeFromSeconds(service.uptime)}
              </div>
              {service.details?.version && (
                <div className="service-version">
                  Version: {service.details.version}
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>
    );
  };
  
  // Render incidents tab
  const renderIncidentsTab = () => {
    return (
      <div className="incidents-tab">
        <div className="incidents-header">
          <h2>Incidents</h2>
          {user?.hasPermission('create_incident') && (
            <Button
              variant="primary"
              icon="plus"
            >
              Report Incident
            </Button>
          )}
        </div>
        
        {incidents.length > 0 ? (
          <div className="incidents-timeline">
            <Timeline
              events={incidents.map(incident => ({
                id: incident.id,
                title: incident.title,
                description: incident.description,
                startTime: incident.startTime,
                endTime: incident.endTime,
                status: incident.status,
                category: incident.severity,
                updates: incident.updates.map(update => ({
                  time: update.timestamp,
                  content: update.message,
                  author: update.author
                }))
              }))}
              height={600}
              onEventClick={(event) => {
                // Handle incident click
              }}
            />
          </div>
        ) : (
          <div className="empty-state">
            <p>No incidents to display</p>
          </div>
        )}
      </div>
    );
  };
  
  // Render alerts tab
  const renderAlertsTab = () => {
    return (
      <div className="alerts-tab">
        <div className="alerts-header">
          <h2>Alerts</h2>
          <div className="alerts-filters">
            <Button
              variant="text"
              className={`filter-btn ${alertFilter === 'all' ? 'active' : ''}`}
              onClick={() => setAlertFilter('all')}
            >
              All
            </Button>
            <Button
              variant="text"
              className={`filter-btn ${alertFilter === 'unacknowledged' ? 'active' : ''}`}
              onClick={() => setAlertFilter('unacknowledged')}
            >
              Unacknowledged
            </Button>
          </div>
        </div>
        
        {filteredAlerts.length > 0 ? (
          <Table
            columns={[
              { key: 'severity', label: 'Severity', width: '100px' },
              { key: 'timestamp', label: 'Time', width: '180px' },
              { key: 'title', label: 'Title', width: '30%' },
              { key: 'message', label: 'Message', width: '40%' },
              { key: 'source', label: 'Source', width: '15%' },
              { key: 'actions', label: 'Actions', width: '100px' }
            ]}
            data={filteredAlerts.map(alert => ({
              severity: (
                <div className={`alert-severity severity-${alert.severity}`}>
                  {alert.severity}
                </div>
              ),
              timestamp: formatTime(new Date(alert.timestamp)),
              title: alert.title,
              message: alert.message,
              source: alert.source,
              actions: (
                <div className="actions-cell">
                  {!alert.acknowledged && user?.hasPermission('ack_alerts') && (
                    <Button
                      variant="text"
                      size="small"
                      onClick={() => handleAcknowledgeAlert(alert.id)}
                    >
                      Acknowledge
                    </Button>
                  )}
                  {alert.serviceId && (
                    <Button
                      variant="icon"
                      icon="external-link"
                      onClick={() => {
                        setSelectedService(alert.serviceId);
                        setActiveTab('services');
                      }}
                      title="View service"
                    />
                  )}
                </div>
              )
            }))}
            rowClassName={(row, index) => {
              const alert = filteredAlerts[index];
              return `severity-${alert.severity} ${!alert.acknowledged ? 'unacknowledged' : ''}`;
            }}
          />
        ) : (
          <div className="empty-state">
            <p>No alerts to display</p>
          </div>
        )}
      </div>
    );
  };
  
  // State for service and alert filters
  const [serviceFilter, setServiceFilter] = useState('all');
  const [alertFilter, setAlertFilter] = useState('all');
  
  // Apply filters
  const filteredServices = serviceStatuses.filter(service => {
    if (serviceFilter === 'all') return true;
    if (serviceFilter === 'critical') return service.status === 'down';
    if (serviceFilter === 'degraded') return service.status === 'degraded';
    return true;
  });
  
  const filteredAlerts = alerts.filter(alert => {
    if (alertFilter === 'all') return true;
    if (alertFilter === 'unacknowledged') return !alert.acknowledged;
    return true;
  });
  
  // Helper function to format uptime
  const formatUptimeFromSeconds = (seconds: number): string => {
    if (!seconds || seconds <= 0) return 'N/A';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  };
  
  return (
    <div className="system-status-dashboard">
      <div className="dashboard-header">
        <h1>System Status</h1>
        <div className="header-actions">
          <div className="last-updated">
            Last updated: {formatTime(new Date(lastUpdated))}
          </div>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={fetchAllData}
            disabled={isLoading}
          >
            {isLoading ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>
      
      {error && (
        <div className="error-message">
          {error}
        </div>
      )}
      
      <Tabs>
        <Tab
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
          label="Overview"
        />
        <Tab
          active={activeTab === 'services'}
          onClick={() => {
            setActiveTab('services');
            setSelectedService(null);
          }}
          label="Services"
        />
        <Tab
          active={activeTab === 'incidents'}
          onClick={() => setActiveTab('incidents')}
          label="Incidents"
          badge={incidents.length}
        />
        <Tab
          active={activeTab === 'alerts'}
          onClick={() => setActiveTab('alerts')}
          label="Alerts"
          badge={alerts.filter(a => !a.acknowledged).length}
        />
      </Tabs>
      
      <div className="dashboard-content">
        {isLoading && serviceStatuses.length === 0 ? (
          <div className="loading-container">
            <Spinner size="large" />
            <p>Loading system status...</p>
          </div>
        ) : (
          <>
            {activeTab === 'overview' && renderOverviewTab()}
            {activeTab === 'services' && renderServicesTab()}
            {activeTab === 'incidents' && renderIncidentsTab()}
            {activeTab === 'alerts' && renderAlertsTab()}
          </>
        )}
      </div>
    </div>
  );
};