import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { useUser } from '../hooks/useUser';
import { DashboardLayout } from '../layouts/DashboardLayout';
import { GridLayout, GridItem } from '../components/layout/GridLayout';
import { WidgetSelector } from '../components/widgets/WidgetSelector';
import { WidgetRenderer } from '../components/widgets/WidgetRenderer';
import { SharedPresence } from '../components/collaboration/SharedPresence';
import { ShareModal } from '../components/modals/ShareModal';
import { PermissionsModal } from '../components/modals/PermissionsModal';
import { CollaborationChat } from '../components/collaboration/CollaborationChat';
import { ActivityLog } from '../components/collaboration/ActivityLog';
import { useDashboardApi } from '../hooks/useDashboardApi';
import { Toolbar } from '../components/common/Toolbar';
import { Button, IconButton, Tooltip } from '../components/common/Button';
import { Spinner } from '../components/common/Spinner';
import { Dropdown } from '../components/common/Dropdown';
import { ConfirmDialog } from '../components/modals/ConfirmDialog';
import { ErrorBoundary } from '../components/common/ErrorBoundary';
import { useToast } from '../hooks/useToast';
import { generateUniqueId } from '../utils/idGenerator';

const CollaborativeDashboard: React.FC = () => {
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const navigate = useNavigate();
  const { socket, connected } = useSocket();
  const { user } = useUser();
  const { showToast } = useToast();
  
  const {
    dashboard,
    loading,
    error,
    saveDashboard,
    fetchDashboard,
    createWidget,
    updateWidget,
    deleteWidget,
    updateLayout
  } = useDashboardApi();
  
  const [layout, setLayout] = useState<any[]>([]);
  const [editMode, setEditMode] = useState<boolean>(false);
  const [widgetSelectorOpen, setWidgetSelectorOpen] = useState<boolean>(false);
  const [widgetBeingEdited, setWidgetBeingEdited] = useState<string | null>(null);
  const [shareModalOpen, setShareModalOpen] = useState<boolean>(false);
  const [permissionsModalOpen, setPermissionsModalOpen] = useState<boolean>(false);
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [activityOpen, setActivityOpen] = useState<boolean>(false);
  const [onlineUsers, setOnlineUsers] = useState<any[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState<boolean>(false);
  const [widgetToDelete, setWidgetToDelete] = useState<string | null>(null);
  const [unsavedChanges, setUnsavedChanges] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  
  // Load dashboard data
  useEffect(() => {
    if (dashboardId) {
      fetchDashboard(dashboardId);
    }
  }, [dashboardId, fetchDashboard]);
  
  // Set layout from dashboard data
  useEffect(() => {
    if (dashboard) {
      setLayout(dashboard.layout || []);
    }
  }, [dashboard]);
  
  // Set up socket connection for real-time collaboration
  useEffect(() => {
    if (!socket || !connected || !dashboardId || !user) return;
    
    // Join dashboard room
    socket.emit('dashboard:join', {
      dashboardId,
      user: {
        id: user.id,
        name: user.displayName,
        email: user.email,
        avatar: user.avatarUrl
      }
    });
    
    // Listen for layout updates from other users
    socket.on('dashboard:layout_update', (updatedLayout) => {
      setLayout(updatedLayout);
    });
    
    // Listen for widget updates from other users
    socket.on('dashboard:widget_update', (widget) => {
      if (dashboard) {
        const updatedWidgets = dashboard.widgets.map(w => 
          w.id === widget.id ? widget : w
        );
        
        // Update local state
        setDashboard({
          ...dashboard,
          widgets: updatedWidgets
        });
      }
    });
    
    // Listen for widget creation from other users
    socket.on('dashboard:widget_create', (widget) => {
      if (dashboard) {
        // Update local state
        setDashboard({
          ...dashboard,
          widgets: [...dashboard.widgets, widget]
        });
      }
    });
    
    // Listen for widget deletion from other users
    socket.on('dashboard:widget_delete', (widgetId) => {
      if (dashboard) {
        // Update local state
        setDashboard({
          ...dashboard,
          widgets: dashboard.widgets.filter(w => w.id !== widgetId),
          layout: dashboard.layout.filter(l => l.i !== widgetId)
        });
      }
    });
    
    // Listen for online users updates
    socket.on('dashboard:users', (users) => {
      setOnlineUsers(users);
    });
    
    // Cleanup on unmount
    return () => {
      socket.emit('dashboard:leave', { dashboardId });
      socket.off('dashboard:layout_update');
      socket.off('dashboard:widget_update');
      socket.off('dashboard:widget_create');
      socket.off('dashboard:widget_delete');
      socket.off('dashboard:users');
    };
  }, [socket, connected, dashboardId, user, dashboard]);
  
  // Update dashboard state helper
  const setDashboard = useCallback((newDashboard: any) => {
    // This would be handled by useDashboardApi in a real implementation
    // Here we're just updating the local state as a simplification
  }, []);
  
  // Handle layout changes
  const handleLayoutChange = useCallback((newLayout: any) => {
    setLayout(newLayout);
    setUnsavedChanges(true);
    
    // Broadcast layout change to other users
    if (socket && connected && dashboardId) {
      socket.emit('dashboard:layout_update', {
        dashboardId,
        layout: newLayout
      });
    }
  }, [socket, connected, dashboardId]);
  
  // Save dashboard changes
  const handleSave = useCallback(async () => {
    if (!dashboard) return;
    
    try {
      setSaving(true);
      
      await saveDashboard({
        ...dashboard,
        layout
      });
      
      setUnsavedChanges(false);
      showToast('Dashboard saved successfully', 'success');
    } catch (error) {
      showToast('Failed to save dashboard', 'error');
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  }, [dashboard, layout, saveDashboard, showToast]);
  
  // Add a new widget
  const handleAddWidget = useCallback(async (widgetType: string, initialConfig: any) => {
    if (!dashboard) return;
    
    try {
      const newWidgetId = generateUniqueId();
      
      // Create a default position for the new widget
      const newLayoutItem = {
        i: newWidgetId,
        x: 0,
        y: Infinity, // Place at the bottom
        w: 6,
        h: 4,
        minW: 2,
        minH: 2
      };
      
      // Create the widget
      const newWidget = {
        id: newWidgetId,
        type: widgetType,
        name: initialConfig.name || `New ${widgetType}`,
        config: initialConfig
      };
      
      // Update the layout
      const newLayout = [...layout, newLayoutItem];
      setLayout(newLayout);
      
      // Create widget in backend
      await createWidget(dashboard.id, newWidget);
      
      // Update local state
      setDashboard({
        ...dashboard,
        widgets: [...dashboard.widgets, newWidget]
      });
      
      // Broadcast to other users
      if (socket && connected) {
        socket.emit('dashboard:widget_create', {
          dashboardId: dashboard.id,
          widget: newWidget
        });
        
        socket.emit('dashboard:layout_update', {
          dashboardId: dashboard.id,
          layout: newLayout
        });
      }
      
      setUnsavedChanges(true);
      showToast(`Added ${widgetType} widget`, 'success');
    } catch (error) {
      showToast('Failed to add widget', 'error');
      console.error('Add widget error:', error);
    }
  }, [dashboard, layout, createWidget, socket, connected, showToast]);
  
  // Update widget configuration
  const handleUpdateWidget = useCallback(async (widgetId: string, updatedConfig: any) => {
    if (!dashboard) return;
    
    try {
      const widgetIndex = dashboard.widgets.findIndex(w => w.id === widgetId);
      
      if (widgetIndex === -1) {
        throw new Error('Widget not found');
      }
      
      const updatedWidget = {
        ...dashboard.widgets[widgetIndex],
        name: updatedConfig.name || dashboard.widgets[widgetIndex].name,
        config: updatedConfig
      };
      
      // Update widget in backend
      await updateWidget(dashboard.id, widgetId, updatedWidget);
      
      // Update local state
      const updatedWidgets = [...dashboard.widgets];
      updatedWidgets[widgetIndex] = updatedWidget;
      
      setDashboard({
        ...dashboard,
        widgets: updatedWidgets
      });
      
      // Broadcast to other users
      if (socket && connected) {
        socket.emit('dashboard:widget_update', {
          dashboardId: dashboard.id,
          widget: updatedWidget
        });
      }
      
      setUnsavedChanges(true);
      showToast('Widget updated', 'success');
    } catch (error) {
      showToast('Failed to update widget', 'error');
      console.error('Update widget error:', error);
    }
  }, [dashboard, updateWidget, socket, connected, showToast]);
  
  // Delete a widget
  const handleDeleteWidget = useCallback(async (widgetId: string) => {
    if (!dashboard) return;
    
    try {
      // Delete widget from backend
      await deleteWidget(dashboard.id, widgetId);
      
      // Update local state
      setDashboard({
        ...dashboard,
        widgets: dashboard.widgets.filter(w => w.id !== widgetId)
      });
      
      // Update layout
      const newLayout = layout.filter(item => item.i !== widgetId);
      setLayout(newLayout);
      
      // Broadcast to other users
      if (socket && connected) {
        socket.emit('dashboard:widget_delete', {
          dashboardId: dashboard.id,
          widgetId
        });
        
        socket.emit('dashboard:layout_update', {
          dashboardId: dashboard.id,
          layout: newLayout
        });
      }
      
      setUnsavedChanges(true);
      showToast('Widget deleted', 'success');
    } catch (error) {
      showToast('Failed to delete widget', 'error');
      console.error('Delete widget error:', error);
    }
  }, [dashboard, layout, deleteWidget, socket, connected, showToast]);
  
  // Confirm widget deletion
  const confirmDeleteWidget = (widgetId: string) => {
    setWidgetToDelete(widgetId);
    setDeleteConfirmOpen(true);
  };
  
  // Handle edit mode toggle
  const toggleEditMode = () => {
    setEditMode(prev => !prev);
  };
  
  if (loading) {
    return (
      <DashboardLayout>
        <div className="loading-container">
          <Spinner size="large" />
          <p>Loading dashboard...</p>
        </div>
      </DashboardLayout>
    );
  }
  
  if (error) {
    return (
      <DashboardLayout>
        <div className="error-container">
          <h2>Error Loading Dashboard</h2>
          <p>{error}</p>
          <Button onClick={() => navigate('/dashboards')}>
            Back to Dashboards
          </Button>
        </div>
      </DashboardLayout>
    );
  }
  
  if (!dashboard) {
    return (
      <DashboardLayout>
        <div className="error-container">
          <h2>Dashboard Not Found</h2>
          <p>The requested dashboard could not be found.</p>
          <Button onClick={() => navigate('/dashboards')}>
            Back to Dashboards
          </Button>
        </div>
      </DashboardLayout>
    );
  }
  
  return (
    <DashboardLayout>
      <div className="collaborative-dashboard">
        <header className="dashboard-header">
          <div className="dashboard-title">
            <h1>{dashboard.name}</h1>
            {unsavedChanges && <span className="unsaved-indicator">*</span>}
          </div>
          
          <Toolbar>
            <Button
              variant={editMode ? 'primary' : 'secondary'}
              onClick={toggleEditMode}
              icon="edit"
            >
              {editMode ? 'Exit Edit Mode' : 'Edit Dashboard'}
            </Button>
            
            {editMode && (
              <Button
                variant="secondary"
                onClick={() => setWidgetSelectorOpen(true)}
                icon="plus"
              >
                Add Widget
              </Button>
            )}
            
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!unsavedChanges || saving}
              icon={saving ? 'spinner' : 'save'}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
            
            <Dropdown
              label="Actions"
              icon="ellipsis-v"
              items={[
                {
                  label: 'Share Dashboard',
                  icon: 'share',
                  onClick: () => setShareModalOpen(true)
                },
                {
                  label: 'Manage Permissions',
                  icon: 'lock',
                  onClick: () => setPermissionsModalOpen(true)
                },
                {
                  label: 'Chat',
                  icon: 'comment',
                  onClick: () => setChatOpen(true)
                },
                {
                  label: 'Activity Log',
                  icon: 'history',
                  onClick: () => setActivityOpen(true)
                },
                {
                  label: 'Export Dashboard',
                  icon: 'download',
                  onClick: () => {/* Export functionality */}
                },
                {
                  label: 'Clone Dashboard',
                  icon: 'copy',
                  onClick: () => {/* Clone functionality */}
                }
              ]}
            />
            
            <SharedPresence users={onlineUsers} />
          </Toolbar>
        </header>
        
        <div className="dashboard-content">
          <ErrorBoundary>
            <GridLayout
              layout={layout}
              onLayoutChange={handleLayoutChange}
              isEditable={editMode}
              useCSSTransforms={true}
              cols={12}
              rowHeight={100}
              margin={[10, 10]}
              containerPadding={[20, 20]}
              className="dashboard-grid"
            >
              {dashboard.widgets.map(widget => (
                <GridItem key={widget.id} id={widget.id}>
                  <WidgetRenderer
                    widget={widget}
                    isEditing={editMode}
                    onEdit={() => setWidgetBeingEdited(widget.id)}
                    onDelete={() => confirmDeleteWidget(widget.id)}
                    onUpdate={(config) => handleUpdateWidget(widget.id, config)}
                  />
                </GridItem>
              ))}
            </GridLayout>
          </ErrorBoundary>
        </div>
        
        {/* Modals and sidebars */}
        {widgetSelectorOpen && (
          <WidgetSelector
            onSelect={handleAddWidget}
            onClose={() => setWidgetSelectorOpen(false)}
          />
        )}
        
        {shareModalOpen && (
          <ShareModal
            dashboardId={dashboard.id}
            dashboardName={dashboard.name}
            onClose={() => setShareModalOpen(false)}
          />
        )}
        
        {permissionsModalOpen && (
          <PermissionsModal
            resourceId={dashboard.id}
            resourceType="dashboard"
            onClose={() => setPermissionsModalOpen(false)}
          />
        )}
        
        {chatOpen && (
          <CollaborationChat
            resourceId={dashboard.id}
            resourceType="dashboard"
            onClose={() => setChatOpen(false)}
          />
        )}
        
        {activityOpen && (
          <ActivityLog
            resourceId={dashboard.id}
            resourceType="dashboard"
            onClose={() => setActivityOpen(false)}
          />
        )}
        
        {deleteConfirmOpen && (
          <ConfirmDialog
            title="Delete Widget"
            message="Are you sure you want to delete this widget? This action cannot be undone."
            confirmLabel="Delete"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={() => {
              if (widgetToDelete) {
                handleDeleteWidget(widgetToDelete);
                setWidgetToDelete(null);
              }
              setDeleteConfirmOpen(false);
            }}
            onCancel={() => {
              setWidgetToDelete(null);
              setDeleteConfirmOpen(false);
            }}
          />
        )}
      </div>
    </DashboardLayout>
  );
};

export default CollaborativeDashboard;