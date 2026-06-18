import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { CalendarPage } from './pages/CalendarPage'
import { ChatPage } from './pages/ChatPage'
import { ContactsPage } from './pages/ContactsPage'
import { MeetingPage } from './pages/MeetingPage'
import { MeetingsPage } from './pages/MeetingsPage'
import { SettingsPage } from './pages/SettingsPage'
import { LoginPage } from './pages/LoginPage'
import { useApp } from './state/AppContext'

export function App(): React.JSX.Element {
  const { authenticated } = useApp()
  if (!authenticated) return <LoginPage />
  return (
    <Routes>
      <Route path="/meeting/:meetingId" element={<MeetingPage />} />
      <Route element={<AppLayout />}>
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  )
}
