export default function DashboardSkeleton() {
  return (
    <div className="dashboard-app dashboard-skeleton" data-testid="dashboard-skeleton" aria-busy="true" aria-label="Loading espresso dashboard">
      <div className="dashboard-skel-block dashboard-skel-title" />
      <div className="dashboard-metrics-row">
        {[0, 1, 2, 3].map((i) => <div key={i} className="dashboard-skel-block dashboard-skel-metric" />)}
      </div>
      <div className="dashboard-skel-block dashboard-skel-tabs" />
      <div className="dashboard-skel-block dashboard-skel-panel" />
      <div className="dashboard-skel-block dashboard-skel-panel" />
    </div>
  )
}
