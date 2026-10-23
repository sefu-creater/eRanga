import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PrismaClient, ClaimStatus, ReportStatus } from '@prisma/client'

const prisma = new PrismaClient()
const app = express()
const port = Number(process.env.PORT || 5000)
const jwtSecret = process.env.JWT_SECRET || 'development-only-change-me'

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }))
app.use(express.json())

type AuthRequest = express.Request & { user?: { id: string; role: 'USER' | 'ADMIN' } }
const auth = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  try {
    req.user = jwt.verify(token, jwtSecret) as AuthRequest['user']
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
const serializeUser = (user: { id: string; name: string; email: string; role: 'USER' | 'ADMIN' }) => ({
  id: user.id, name: user.name, email: user.email, initials: user.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(), role: user.role.toLowerCase(),
})
const serializeReport = (report: any) => ({ ...report, type: report.type.toLowerCase(), status: report.status.toLowerCase(), ownerId: report.ownerId, createdAt: report.createdAt.toISOString(), date: report.date.toISOString().slice(0, 10), owner: report.owner?.name || '' })
const serializeClaim = (claim: any) => ({ id: claim.id, reportId: claim.reportId, claimantId: claim.claimantId, note: claim.note, status: claim.status.toLowerCase(), createdAt: claim.createdAt.toISOString() })
const serializeMessage = (message: any) => ({ id: message.id, claimId: message.claimId, senderId: message.senderId, body: message.body, createdAt: message.createdAt.toISOString() })
const serializeNotification = (notification: any) => ({ id: notification.id, type: notification.type, title: notification.title, body: notification.body, reportId: notification.reportId, read: notification.read, createdAt: notification.createdAt.toISOString() })
const matchScore = (source: { type: string; title: string; description: string; category: string; location: string }, candidate: { type: string; title: string; description: string; category: string; location: string }) => {
  if (source.type === candidate.type) return 0
  const sourceWords = `${source.title} ${source.description}`.toLowerCase().split(/\W+/).filter((word) => word.length > 3)
  const candidateText = `${candidate.title} ${candidate.description}`.toLowerCase()
  const sharedWords = sourceWords.filter((word) => candidateText.includes(word)).length
  let score = Math.min(sharedWords * 12, 48)
  if (source.category.toLowerCase() === candidate.category.toLowerCase()) score += 22
  if (source.location.toLowerCase().split(/[ ,]+/)[0] === candidate.location.toLowerCase().split(/[ ,]+/)[0]) score += 18
  return Math.min(score, 96)
}

app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    return res.json({ status: 'ok', database: 'connected' })
  } catch {
    return res.status(503).json({ status: 'error', database: 'unavailable' })
  }
})
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of at least 8 characters are required' })
  try {
    const user = await prisma.user.create({ data: { name, email: email.toLowerCase(), password: await bcrypt.hash(password, 12) } })
    const token = jwt.sign({ id: user.id, role: user.role }, jwtSecret, { expiresIn: '7d' })
    return res.status(201).json({ token, user: serializeUser(user) })
  } catch (error: any) { return res.status(error.code === 'P2002' ? 409 : 500).json({ error: error.code === 'P2002' ? 'An account with this email already exists' : 'Could not create account' }) }
})
app.post('/api/auth/login', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: String(req.body.email || '').toLowerCase() } })
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password))) return res.status(401).json({ error: 'Invalid email or password' })
  return res.json({ token: jwt.sign({ id: user.id, role: user.role }, jwtSecret, { expiresIn: '7d' }), user: serializeUser(user) })
})
app.get('/api/me', auth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } })
  return res.json({ user: serializeUser(user) })
})
app.get('/api/reports', async (_req, res) => {
  try {
    const reports = await prisma.report.findMany({ where: { status: { not: ReportStatus.RECOVERED } }, include: { owner: true }, orderBy: { createdAt: 'desc' } })
    return res.json(reports.map(serializeReport))
  } catch {
    return res.status(503).json({ error: 'The shared report database is unavailable' })
  }
})
app.post('/api/reports', auth, async (req: AuthRequest, res) => {
  const { type, title, category, description, location, date, image } = req.body
  const normalizedType = String(type || '').toUpperCase()
  const parsedDate = new Date(date)
  if (!['LOST', 'FOUND'].includes(normalizedType) || !title?.trim() || !category?.trim() || !description?.trim() || !location?.trim() || !image?.trim() || Number.isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Type, title, category, description, location, image, and a valid date are required' })
  }
  const report = await prisma.report.create({ data: { type: normalizedType as 'LOST' | 'FOUND', title: title.trim(), category: category.trim(), description: description.trim(), location: location.trim(), date: parsedDate, image: image.trim(), ownerId: req.user!.id }, include: { owner: true } })
  const candidates = await prisma.report.findMany({ where: { id: { not: report.id }, type: normalizedType === 'LOST' ? 'FOUND' : 'LOST', status: 'ACTIVE' }, include: { owner: true } })
  const matches = candidates.map((candidate) => ({ report: candidate, score: matchScore(report, candidate) })).filter((match) => match.score >= 35).sort((a, b) => b.score - a.score).slice(0, 5)
  if (matches.length) {
    await prisma.notification.createMany({ data: [
      { userId: req.user!.id, type: 'likely_match', title: 'Likely match found', body: `We found ${matches.length} possible match${matches.length === 1 ? '' : 'es'} for "${report.title}".`, reportId: report.id },
      ...matches.map(({ report: match, score }) => ({ userId: match.ownerId, type: 'likely_match', title: 'A report may match yours', body: `"${report.title}" is a ${score}% match with "${match.title}".`, reportId: report.id })),
    ] })
  }
  return res.status(201).json({ report: serializeReport(report), likelyMatches: matches.map(({ report: match, score }) => ({ report: serializeReport(match), score })), notificationSent: matches.length > 0 })
})
app.delete('/api/reports/:id', auth, async (req: AuthRequest, res) => {
  const reportId = String(req.params.id)
  const report = await prisma.report.findUnique({ where: { id: reportId } })
  if (!report || (report.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) return res.status(404).json({ error: 'Report not found' })
  await prisma.report.delete({ where: { id: reportId } }); return res.status(204).send()
})
app.patch('/api/reports/:id', auth, async (req: AuthRequest, res) => {
  const reportId = String(req.params.id)
  const report = await prisma.report.findUnique({ where: { id: reportId } })
  if (!report || (report.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) return res.status(404).json({ error: 'Report not found' })
  const updated = await prisma.report.update({ where: { id: report.id }, data: { status: String(req.body.status).toUpperCase() as ReportStatus }, include: { owner: true } })
  return res.json(serializeReport(updated))
})
app.get('/api/data', auth, async (_req: AuthRequest, res) => {
  const [reports, claims, messages, notifications] = await Promise.all([
    prisma.report.findMany({ include: { owner: true }, orderBy: { createdAt: 'desc' } }),
    prisma.claim.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.message.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.notification.findMany({ where: { userId: _req.user!.id }, orderBy: { createdAt: 'desc' } }),
  ])
  return res.json({ reports: reports.map(serializeReport), claims: claims.map(serializeClaim), messages: messages.map(serializeMessage), notifications: notifications.map(serializeNotification) })
})
app.get('/api/notifications', auth, async (req: AuthRequest, res) => res.json((await prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } })).map(serializeNotification)))
app.post('/api/claims', auth, async (req: AuthRequest, res) => {
  try { const claim = await prisma.claim.create({ data: { reportId: req.body.reportId, claimantId: req.user!.id, note: req.body.note }, include: { report: true } }); return res.status(201).json(serializeClaim(claim)) }
  catch (error: any) { return res.status(error.code === 'P2002' ? 409 : 500).json({ error: 'Could not submit claim' }) }
})
app.patch('/api/claims/:id', auth, async (req: AuthRequest, res) => {
  const claim = await prisma.claim.findUnique({ where: { id: String(req.params.id) }, include: { report: true } })
  if (!claim || (claim.report.ownerId !== req.user!.id && req.user!.role !== 'ADMIN')) return res.status(404).json({ error: 'Claim not found' })
  const status = String(req.body.status).toUpperCase() as ClaimStatus
  const updated = await prisma.claim.update({ where: { id: claim.id }, data: { status } })
  if (status === ClaimStatus.VERIFIED) await prisma.report.update({ where: { id: claim.reportId }, data: { status: ReportStatus.CLAIMED } })
  return res.json(serializeClaim(updated))
})
app.post('/api/messages', auth, async (req: AuthRequest, res) => {
  const claim = await prisma.claim.findUnique({ where: { id: req.body.claimId }, include: { report: true } })
  if (!claim || claim.status !== ClaimStatus.VERIFIED || (claim.claimantId !== req.user!.id && claim.report.ownerId !== req.user!.id)) return res.status(403).json({ error: 'Messaging is only available to verified participants' })
  return res.status(201).json(serializeMessage(await prisma.message.create({ data: { claimId: claim.id, senderId: req.user!.id, body: req.body.body } })))
})

app.listen(port, () => console.log(`eRanga API listening on http://localhost:${port}`))
