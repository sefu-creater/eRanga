import 'dotenv/config'

const base = `http://localhost:${process.env.PORT || 5000}/api`
const email = `smoke-${Date.now()}@example.com`
const request = async (path: string, options?: RequestInit) => {
  const response = await fetch(`${base}${path}`, options)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body?.error || ''}`)
  return body
}

const health = await request('/health')
const registration = await request('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Test', email, password: 'password123' }) })
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${registration.token}` }
const reportResult = await request('/reports', { method: 'POST', headers, body: JSON.stringify({ type: 'lost', title: 'Smoke report', category: 'Other', description: 'API smoke test', location: 'Test venue', date: new Date().toISOString().slice(0, 10), image: 'https://example.com/item.jpg' }) })
const report = reportResult.report
const reports = await request('/reports')
if (!reports.some((item: { id: string }) => item.id === report.id)) throw new Error('Created report was not returned by the read endpoint')
console.log(JSON.stringify({ health, createdReport: report.id, likelyMatches: reportResult.likelyMatches.length, notificationSent: reportResult.notificationSent, persisted: true }))
