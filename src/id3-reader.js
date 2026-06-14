// Minimal audio tag reader.
// MP3 (ID3v2): title (TIT2), artist (TPE1), album (TALB), embedded lyrics (USLT).
// FLAC (Vorbis comments): TITLE, ARTIST, ALBUM, (UNSYNCED)LYRICS.

export async function readID3Tags(file) {
  const result = { title: '', artist: '', album: '', lyrics: '' }

  try {
    // Peek the first 4 bytes to pick a container format.
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())

    // FLAC magic: "fLaC"
    if (head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) {
      return await readFlacTags(file, result)
    }

    // Read the first 128KB — enough for ID3v2 header + common tags
    const slice = file.slice(0, 131072)
    const buffer = await slice.arrayBuffer()
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)

    // Check for ID3v2 header: "ID3"
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      // Try ID3v1 at end of file (last 128 bytes)
      return await tryID3v1(file, result)
    }

    const version = bytes[3] // 3 = ID3v2.3, 4 = ID3v2.4
    const flags = bytes[5]
    const hasExtHeader = (flags & 0x40) !== 0

    // Tag size (syncsafe integer)
    const tagSize = decodeSyncsafe(view, 6)
    let offset = 10

    // Skip extended header if present
    if (hasExtHeader) {
      const extSize = version === 4
        ? decodeSyncsafe(view, offset)
        : view.getUint32(offset)
      offset += extSize
    }

    const tagEnd = Math.min(10 + tagSize, buffer.byteLength)

    // Parse frames
    while (offset + 10 < tagEnd) {
      const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])

      // Stop if we hit padding (null bytes)
      if (frameId[0] === '\0') break

      const frameSize = version === 4
        ? decodeSyncsafe(view, offset + 4)
        : view.getUint32(offset + 4)

      if (frameSize <= 0 || offset + 10 + frameSize > tagEnd) break

      const frameData = bytes.slice(offset + 10, offset + 10 + frameSize)

      switch (frameId) {
        case 'TIT2':
          result.title = decodeTextFrame(frameData)
          break
        case 'TPE1':
          result.artist = decodeTextFrame(frameData)
          break
        case 'TALB':
          result.album = decodeTextFrame(frameData)
          break
        case 'USLT':
          result.lyrics = decodeUSLTFrame(frameData)
          break
      }

      offset += 10 + frameSize
    }
  } catch (e) {
    console.warn('ID3 parse error:', e)
  }

  // If no title, use filename
  if (!result.title) {
    result.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
  }

  return result
}

function decodeSyncsafe(view, offset) {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  )
}

function decodeTextFrame(data) {
  if (data.length < 2) return ''
  const encoding = data[0]
  const textBytes = data.slice(1)

  switch (encoding) {
    case 0: // ISO-8859-1
      return decodeLatin1(textBytes)
    case 1: // UTF-16 with BOM
      return decodeUTF16(textBytes)
    case 2: // UTF-16BE
      return decodeUTF16BE(textBytes)
    case 3: // UTF-8
      return new TextDecoder('utf-8').decode(textBytes)
    default:
      return decodeLatin1(textBytes)
  }
}

function decodeUSLTFrame(data) {
  if (data.length < 5) return ''
  const encoding = data[0]
  // Skip language (3 bytes) and content descriptor (variable, null-terminated)
  let offset = 4 // encoding + 3 bytes language

  // Skip content descriptor (null terminated)
  if (encoding === 0 || encoding === 3) {
    while (offset < data.length && data[offset] !== 0) offset++
    offset++ // skip null
  } else {
    // UTF-16: look for double-null
    while (offset + 1 < data.length && !(data[offset] === 0 && data[offset + 1] === 0)) offset += 2
    offset += 2
  }

  const textBytes = data.slice(offset)
  switch (encoding) {
    case 0: return decodeLatin1(textBytes)
    case 1: return decodeUTF16(textBytes)
    case 2: return decodeUTF16BE(textBytes)
    case 3: return new TextDecoder('utf-8').decode(textBytes)
    default: return decodeLatin1(textBytes)
  }
}

function decodeLatin1(bytes) {
  let str = ''
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) break
    str += String.fromCharCode(bytes[i])
  }
  return str
}

function decodeUTF16(bytes) {
  if (bytes.length < 2) return ''
  // Check BOM
  const bom = (bytes[0] << 8) | bytes[1]
  const le = bom === 0xfffe
  const start = (bom === 0xfeff || bom === 0xfffe) ? 2 : 0
  let str = ''
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const code = le ? (bytes[i + 1] << 8) | bytes[i] : (bytes[i] << 8) | bytes[i + 1]
    if (code === 0) break
    str += String.fromCharCode(code)
  }
  return str
}

function decodeUTF16BE(bytes) {
  let str = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1]
    if (code === 0) break
    str += String.fromCharCode(code)
  }
  return str
}

// FLAC stores metadata in a chain of blocks after the "fLaC" marker.
// Each block: 1 byte header (bit 7 = last-block flag, bits 0-6 = type) + 3-byte
// big-endian length, then the block body. Type 4 is VORBIS_COMMENT. A PICTURE
// block (type 6) can be megabytes, so walk headers with small slices rather than
// reading a fixed-size prefix that might not reach the comments.
async function readFlacTags(file, result) {
  let offset = 4 // skip "fLaC"
  const maxBlocks = 64 // guard against malformed chains

  for (let i = 0; i < maxBlocks; i++) {
    if (offset + 4 > file.size) break
    const header = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer())
    const isLast = (header[0] & 0x80) !== 0
    const blockType = header[0] & 0x7f
    const blockSize = (header[1] << 16) | (header[2] << 8) | header[3]
    const bodyStart = offset + 4

    if (blockType === 4) {
      const body = new Uint8Array(await file.slice(bodyStart, bodyStart + blockSize).arrayBuffer())
      parseVorbisComment(body, result)
      break
    }

    if (isLast) break
    offset = bodyStart + blockSize
  }

  if (!result.title) {
    result.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
  }

  return result
}

// VORBIS_COMMENT body: uint32-LE vendor length + vendor string, uint32-LE comment
// count, then each comment as uint32-LE length + UTF-8 "FIELD=value".
function parseVorbisComment(body, result) {
  const utf8 = new TextDecoder('utf-8')
  const readU32LE = (p) => body[p] | (body[p + 1] << 8) | (body[p + 2] << 16) | (body[p + 3] << 24)

  let p = 0
  if (p + 4 > body.length) return
  const vendorLen = readU32LE(p) >>> 0
  p += 4 + vendorLen
  if (p + 4 > body.length) return
  const count = readU32LE(p) >>> 0
  p += 4

  for (let i = 0; i < count; i++) {
    if (p + 4 > body.length) break
    const len = readU32LE(p) >>> 0
    p += 4
    if (p + len > body.length) break
    const comment = utf8.decode(body.slice(p, p + len))
    p += len

    const eq = comment.indexOf('=')
    if (eq === -1) continue
    const key = comment.slice(0, eq).toUpperCase()
    const value = comment.slice(eq + 1)

    switch (key) {
      case 'TITLE':
        if (!result.title) result.title = value
        break
      case 'ARTIST':
        if (!result.artist) result.artist = value
        break
      case 'ALBUM':
        if (!result.album) result.album = value
        break
      case 'LYRICS':
      case 'UNSYNCEDLYRICS':
      case 'UNSYNCED LYRICS':
      case 'SYNCEDLYRICS':
      case 'LRC':
        if (!result.lyrics) result.lyrics = value
        break
    }
  }
}

async function tryID3v1(file, result) {
  if (file.size < 128) return result
  const slice = file.slice(file.size - 128)
  const buffer = await slice.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  // Check "TAG" marker
  if (bytes[0] !== 0x54 || bytes[1] !== 0x41 || bytes[2] !== 0x47) {
    result.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
    return result
  }

  result.title = decodeLatin1(bytes.slice(3, 33)).trim()
  result.artist = decodeLatin1(bytes.slice(33, 63)).trim()
  result.album = decodeLatin1(bytes.slice(63, 93)).trim()

  if (!result.title) {
    result.title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
  }

  return result
}
