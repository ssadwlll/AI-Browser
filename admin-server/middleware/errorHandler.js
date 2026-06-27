/**
 * 全局错误处理中间件
 */
module.exports = (err, req, res, next) => {
  console.error('[Error]', err.message || err)

  if (err.name === 'MulterError') {
    const messages = {
      LIMIT_FILE_SIZE: '文件大小超过限制（最大 5MB）',
      LIMIT_FILE_COUNT: '文件数量超过限制',
      LIMIT_UNEXPECTED_FILE: '意外的文件字段',
    }
    return res.status(400).json({
      success: false,
      error: messages[err.code] || err.message,
    })
  }

  if (err.message === '只允许上传 .js 脚本文件') {
    return res.status(400).json({ success: false, error: err.message })
  }

  res.status(500).json({ success: false, error: '服务器内部错误' })
}