const http = require('http')
const fs = require('fs')

// Step 1: Login
const loginBody = JSON.stringify({ username: 'admin', password: 'admin123' })
const loginReq = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) }
}, (loginRes) => {
  let data = ''
  loginRes.on('data', chunk => data += chunk)
  loginRes.on('end', () => {
    console.log('Login response:', data)
    const parsed = JSON.parse(data)
    if (!parsed.data || !parsed.data.token) {
      console.error('No token received')
      return
    }
    const token = parsed.data.token

    // Step 2: Upload file
    const boundary = '----FormBoundary123456'
    const fileContent = '// test script\nconsole.log("hello")\n'

    let body = ''
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="name"\r\n\r\n`
    body += `test-script\r\n`
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="category_id"\r\n\r\n`
    body += `1\r\n`
    body += `--${boundary}\r\n`
    body += `Content-Disposition: form-data; name="script"; filename="test.js"\r\n`
    body += `Content-Type: application/javascript\r\n\r\n`
    body += `${fileContent}\r\n`
    body += `--${boundary}--\r\n`

    const bodyBuffer = Buffer.from(body, 'utf-8')

    const uploadReq = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/scripts',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length
      }
    }, (uploadRes) => {
      let uploadData = ''
      uploadRes.on('data', chunk => uploadData += chunk)
      uploadRes.on('end', () => {
        console.log('Upload status:', uploadRes.statusCode)
        console.log('Upload response:', uploadData)
      })
    })

    uploadReq.on('error', (err) => {
      console.error('Upload error:', err.message)
    })

    uploadReq.write(bodyBuffer)
    uploadReq.end()
  })
})

loginReq.on('error', (err) => {
  console.error('Login error:', err.message)
})

loginReq.write(loginBody)
loginReq.end()
