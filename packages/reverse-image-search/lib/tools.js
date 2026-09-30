/**
 * Model-facing search-by-image tools.
 *
 * Definitions are plain JSON-Schema tool declarations, so the package imports
 * nothing from the harness runtime.
 *
 * @module dsh-reverse-image-search/tools
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { searchByImage } from './engine.js'
import { downloadImage, MAX_IMAGE_BYTES } from './http.js'

/** Render one canonical value as pretty JSON text. */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/**
 * Build one registry-ready tool declaration.
 * @param options - name, description, parameter properties, required keys, and body.
 * @returns the plain tool definition the DSH tool registry accepts.
 */
function defineTool({ name, description, properties, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    output: { schema: {}, render: renderJson },
    execute,
  }
}

/** Read one optional non-empty string argument. */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

/** Read one optional positive integer argument. */
function optionalLimit(args, fallback, max) {
  const value = args.limit
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('limit must be a positive integer')
  }
  return Math.min(value, max)
}

/** Derive a local file extension from a URL path, defaulting to .png. */
function extensionFor(url) {
  try {
    const name = new URL(url).pathname
    const extension = extname(name).toLowerCase()
    return /^\.(png|jpe?g|webp|gif|bmp|avif)$/.test(extension) ? extension : '.png'
  } catch {
    return '.png'
  }
}

/**
 * Build the search-by-image tool definitions.
 * @param resolvePath - harness filesystem resolution; it receives the tool
 *   execution so a relative path resolves against the calling agent's session
 *   workspace.
 * @returns registry-ready tool declarations.
 */
export function createImageTools(resolvePath) {
  return [
    defineTool({
      name: 'image_search',
      description:
        'Reverse image search: find where an image comes from and what it shows. Give it a local ' +
        'image path or an image URL, never a text query; it opens the image in Baidu 识图 and returns ' +
        'the recognition phrase plus similar images and any matching pages. Use it to identify an ' +
        'avatar, a product photo, a screenshot, or the origin of a picture the user supplied.',
      properties: {
        image_path: {
          type: 'string',
          description: 'Workspace-relative or absolute path of the image to search with.',
        },
        image_url: {
          type: 'string',
          description: 'Absolute http(s) URL of the image to search with.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum similar images and pages to return. Defaults to 8, maximum 24.',
        },
        engine: {
          type: 'string',
          enum: ['baidu'],
          description: 'Search engine to use. Defaults to baidu, the only keyless engine reachable without a proxy.',
        },
      },
      execute: async (args, exec) => {
        const imagePath = optionalString(args, 'image_path')
        const imageUrl = optionalString(args, 'image_url')
        if ((imagePath ? 1 : 0) + (imageUrl ? 1 : 0) !== 1) {
          throw new Error('provide exactly one of image_path or image_url')
        }
        const limit = optionalLimit(args, 8, 24)
        const engine = optionalString(args, 'engine')

        let queryPath
        let temporary = false
        if (imagePath) {
          const resolved = await resolvePath(imagePath, exec)
          const stats = await readFile(resolved).catch(() => undefined)
          if (!stats) throw new Error(`image not found: ${imagePath}`)
          if (stats.byteLength > MAX_IMAGE_BYTES) {
            throw new Error(`image is ${stats.byteLength} bytes, above the 25 MB limit`)
          }
          queryPath = resolved
        } else {
          queryPath = join(tmpdir(), 'dsh-image-search', `query-${Date.now()}${extensionFor(imageUrl)}`)
          await downloadImage(imageUrl, queryPath)
          temporary = true
        }

        try {
          const outcome = await searchByImage({ imagePath: queryPath, engine, limit })
          return {
            query: imagePath ? { source: 'path', value: imagePath } : { source: 'url', value: imageUrl },
            ...outcome,
          }
        } finally {
          if (temporary) await rm(queryPath, { force: true }).catch(() => undefined)
        }
      },
    }),
    defineTool({
      name: 'image_download',
      description:
        'Download one image URL (for example a similar image from image_search) into the workspace ' +
        'and return the written path.',
      properties: {
        url: { type: 'string', description: 'Image URL to download.' },
        path: {
          type: 'string',
          description: 'Output path; relative paths resolve against the workspace. Defaults to image-search/image-<timestamp>.<ext>.',
        },
      },
      required: ['url'],
      execute: async (args, exec) => {
        const url = optionalString(args, 'url')
        if (!url) throw new Error('url is required')
        let parsed
        try {
          parsed = new URL(url)
        } catch {
          throw new Error('url must be an absolute http(s) URL')
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('url must use http or https')
        }
        const target = optionalString(args, 'path') ?? `image-search/image-${Date.now()}${extensionFor(url)}`
        const resolved = await resolvePath(target, exec)
        const { bytes, contentType } = await downloadImage(url, resolved)
        return { path: resolved, bytes, contentType, sourceUrl: url }
      },
    }),
  ]
}