/**
 * 统一响应格式
 */

function success(data, message = '操作成功') {
  return { success: true, data, message }
}

function error(message = '服务器错误', code = 500) {
  return { success: false, error: message, code }
}

function paginated(rows, page, pageSize, total) {
  return {
    success: true,
    data: rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

module.exports = { success, error, paginated }