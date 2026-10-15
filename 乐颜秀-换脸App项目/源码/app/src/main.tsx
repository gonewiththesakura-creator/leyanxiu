import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import App from './App.tsx'
import { initializeNativeUi } from './lib/native.ts'
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx'

const AdminApp = lazy(() => import('./admin/AdminApp.tsx'))

const adminRoute = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')
if (!adminRoute) void initializeNativeUi()
if (adminRoute) document.title = '乐颜秀运营后台'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      {adminRoute ? (
        <Suspense fallback={<div className="admin-boot">正在打开运营后台...</div>}>
          <AdminApp />
        </Suspense>
      ) : <App />}
    </AppErrorBoundary>
  </StrictMode>,
)
