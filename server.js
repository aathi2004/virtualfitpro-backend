/**
 * VirtualFit Pro - Backend
 * Express + MongoDB (with in-memory fallback)
 */
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const mongoose = require('mongoose')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const Replicate = require('replicate')
const { GoogleGenerativeAI } = require('@google/generative-ai')

const PORT = process.env.PORT || 8000
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/virtualfit'
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123'
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

// Initialize Replicate (for AI try-on)
const replicate = REPLICATE_API_TOKEN 
  ? new Replicate({ auth: REPLICATE_API_TOKEN })
  : null

// Initialize Gemini (for garment design)
const genAI = GEMINI_API_KEY 
  ? new GoogleGenerativeAI(GEMINI_API_KEY)
  : null

// ── Uploads folder ─────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOADS_DIR))

// ── Multer configuration ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png'
    cb(null, `garment_${Date.now()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image files allowed'))
  },
})

// ── Mongoose schema ───────────────────────────────────────────
const garmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, required: true },
  gender: { type: String, enum: ['men', 'women', 'unisex'], default: 'men' },
  image: { type: String, required: true },
  color: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
})
const Garment = mongoose.model('Garment', garmentSchema)

// ── In-memory fallback store ──────────────────────────────────
let useMemoryStore = false
const memoryStore = []
let memCounter = 1
const memId = () => `mem_${memCounter++}_${Date.now()}`

// ── Connect Mongo (or fall back) ──────────────────────────────
mongoose
  .connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 })
  .then(() => {
    console.log('✓ MongoDB connected')
  })
  .catch((err) => {
    console.warn('⚠  MongoDB unavailable — using in-memory store')
    console.warn('   Reason:', err.message)
    useMemoryStore = true
  })

// ── Helpers ───────────────────────────────────────────────────
const listGarments = async (gender) => {
  if (useMemoryStore) {
    let items = [...memoryStore]
    if (gender) items = items.filter((g) => g.gender === gender || g.gender === 'unisex')
    return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }
  const filter = gender ? { $or: [{ gender }, { gender: 'unisex' }] } : {}
  return Garment.find(filter).sort({ createdAt: -1 }).lean()
}

const createGarment = async (doc) => {
  if (useMemoryStore) {
    const item = { _id: memId(), ...doc, createdAt: new Date() }
    memoryStore.push(item)
    return item
  }
  return Garment.create(doc)
}

const findGarmentById = async (id) => {
  if (useMemoryStore) return memoryStore.find((g) => g._id === id)
  if (!mongoose.isValidObjectId(id)) return null
  return Garment.findById(id).lean()
}

const removeGarmentById = async (id) => {
  if (useMemoryStore) {
    const idx = memoryStore.findIndex((g) => g._id === id)
    if (idx === -1) return null
    const [removed] = memoryStore.splice(idx, 1)
    return removed
  }
  if (!mongoose.isValidObjectId(id)) return null
  return Garment.findByIdAndDelete(id).lean()
}

// ── Routes ────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    store: useMemoryStore ? 'memory' : 'mongodb',
    time: new Date().toISOString(),
  })
})

app.get('/api/garments', async (req, res) => {
  try {
    const { gender } = req.query
    const garments = await listGarments(gender)
    res.json(garments)
  } catch (err) {
    console.error('GET /api/garments', err)
    res.status(500).json({ error: 'Failed to fetch garments' })
  }
})

app.post('/api/garments', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image is required' })
    const { name, category, gender = 'men', color = '' } = req.body
    if (!name || !category) {
      // remove uploaded file if validation fails
      try { fs.unlinkSync(req.file.path) } catch (_) {}
      return res.status(400).json({ error: 'name and category are required' })
    }
    const created = await createGarment({
      name,
      category,
      gender,
      color,
      image: req.file.filename,
    })
    res.status(201).json(created)
  } catch (err) {
    console.error('POST /api/garments', err)
    res.status(500).json({ error: 'Failed to create garment' })
  }
})

app.delete('/api/garments/:id', async (req, res) => {
  try {
    const removed = await removeGarmentById(req.params.id)
    if (!removed) return res.status(404).json({ error: 'Not found' })
    // delete the image file
    if (removed.image) {
      const filePath = path.join(UPLOADS_DIR, removed.image)
      fs.unlink(filePath, (err) => {
        if (err && err.code !== 'ENOENT') console.warn('unlink failed:', err.message)
      })
    }
    res.json({ ok: true, _id: removed._id })
  } catch (err) {
    console.error('DELETE /api/garments/:id', err)
    res.status(500).json({ error: 'Failed to delete garment' })
  }
})

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {}
  if (password === ADMIN_PASS) {
    return res.json({ ok: true, token: `admin_${Date.now()}` })
  }
  return res.status(401).json({ error: 'Invalid password' })
})

// ── AI Try-On via Replicate ───────────────────────────────────
app.post('/api/tryon', async (req, res) => {
  try {
    if (!replicate) {
      return res.status(503).json({
        success: false,
        error: 'Replicate API not configured. Add REPLICATE_API_TOKEN to .env',
      })
    }

    const { person_image, garment_image } = req.body

    if (!person_image || !garment_image) {
      return res.status(400).json({
        success: false,
        error: 'person_image and garment_image required',
      })
    }

    console.log('🎨 Starting IDM-VTON via Replicate...')

    const output = await replicate.run(
      'cuuupid/idm-vton:c871bb9b046607b680449ecbae55fd8c6d945e0a1948644bf2361b3d021d3ff4',
      {
        input: {
          human_img: person_image,
          garm_img: garment_image,
          garment_des: 'clothing item',
          seed: 42,
          n_samples: 1,
          n_steps: 30,
          image_scale: 1.0,
        },
      }
    )

    // Replicate returns a URL to the result image
    const imageUrl = Array.isArray(output) ? output[0] : output

    if (!imageUrl) {
      throw new Error('No output from Replicate')
    }

    // Fetch the image and convert to base64
    const imageResponse = await fetch(imageUrl)
    const arrayBuffer = await imageResponse.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    console.log('✅ IDM-VTON complete!')

    res.json({
      success: true,
      image: base64, // Base64 string (frontend expects this)
    })
  } catch (err) {
    console.error('❌ Replicate error:', err)
    res.status(500).json({
      success: false,
      error: err.message || 'Try-on generation failed',
    })
  }
})

// ── AI Garment Design via Gemini ──────────────────────────────
app.post('/api/design-garment', async (req, res) => {
  try {
    if (!genAI) {
      return res.status(503).json({
        success: false,
        error: 'Gemini API not configured. Add GEMINI_API_KEY to .env',
      })
    }

    const { prompt, gender, category } = req.body

    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: 'Prompt is required',
      })
    }

    console.log('🎨 Generating garment design with Gemini...')

    // Use Gemini's Imagen model for image generation
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

    // Enhanced prompt for better garment generation
    const enhancedPrompt = `Create a high-quality, professional product photograph of a ${category || 'clothing item'} for ${gender || 'unisex'} fashion.

Design description: ${prompt}

Requirements:
- Pure white background (#FFFFFF)
- Studio lighting with soft shadows
- Front-facing view, centered
- PNG format with transparent background if possible
- Professional fashion photography style
- Clean, crisp details
- No model wearing it (garment only)
- High resolution, product catalog quality

Style: Fashion e-commerce product photo`

    const result = await model.generateContent(enhancedPrompt)
    const response = result.response
    const text = response.text()

    // Since Gemini 1.5 Flash doesn't generate images directly,
    // we'll use it to create a detailed description and then
    // call Replicate's SDXL for actual image generation
    
    console.log('📝 Gemini description generated, calling Replicate SDXL...')

    if (!replicate) {
      throw new Error('Replicate required for image generation')
    }

    const imageOutput = await replicate.run(
      'stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b',
      {
        input: {
          prompt: enhancedPrompt,
          negative_prompt: 'person, model, mannequin, human, face, hands, low quality, blurry, watermark, text, logo, wrinkled, dirty',
          width: 768,
          height: 1024,
          num_inference_steps: 30,
          guidance_scale: 7.5,
          scheduler: 'DPMSolverMultistep',
        }
      }
    )

    const imageUrl = Array.isArray(imageOutput) ? imageOutput[0] : imageOutput

    if (!imageUrl) {
      throw new Error('No image generated')
    }

    // Fetch and convert to base64
    const imageResponse = await fetch(imageUrl)
    const arrayBuffer = await imageResponse.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    console.log('✅ Garment design complete!')

    res.json({
      success: true,
      image: base64,
      description: text,
    })

  } catch (err) {
    console.error('❌ Garment design error:', err)
    res.status(500).json({
      success: false,
      error: err.message || 'Design generation failed',
    })
  }
})

// ── Multer error handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message })
  }
  if (err) {
    console.error(err)
    return res.status(500).json({ error: err.message || 'Server error' })
  }
})

app.listen(PORT, () => {
  console.log(`✓ VirtualFit Pro API listening on http://localhost:${PORT}`)
})
