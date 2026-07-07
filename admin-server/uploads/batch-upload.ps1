# 批量上传脚本
$token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc4MzM4OTgxMCwiZXhwIjoxNzgzOTk0NjEwfQ.9HV6CCyWFSJloL8mEaRkotEgcWQ1ymdtUUurqjVayWw"
$baseUrl = "http://localhost:3001"

$scripts = @(
    @{ file = "batch-image-download.js"; name = "图片批量下载"; cat = 1; desc = "提取页面所有图片，支持按最小分辨率筛选，预览勾选后批量下载为ZIP" },
    @{ file = "reading-mode.js"; name = "阅读模式"; cat = 3; desc = "提取网页正文内容，去除广告和干扰元素，提供纯净阅读体验" },
    @{ file = "dark-mode.js"; name = "网页暗黑模式"; cat = 3; desc = "一键切换网页暗黑模式，智能反转颜色，保护视力" },
    @{ file = "element-selector-extract.js"; name = "网页元素选择器提取"; cat = 1; desc = "点击选择页面元素，自动生成CSS选择器，批量提取数据" },
    @{ file = "weibo-hotsearch.js"; name = "微博热搜采集"; cat = 1; desc = "采集微博热搜榜单，支持一键导出JSON" },
    @{ file = "wechat-articles.js"; name = "公众号文章列表采集"; cat = 1; desc = "采集微信公众号文章列表，支持分页滚动采集" },
    @{ file = "table-export.js"; name = "表格数据导出"; cat = 1; desc = "自动检测页面中的表格，一键导出为CSV或JSON文件" },
    @{ file = "full-screenshot.js"; name = "网页长截图"; cat = 2; desc = "自动滚动截取整个网页，拼合为长图下载" },
    @{ file = "bilibili-video-download.js"; name = "B站视频下载助手"; cat = 1; desc = "在B站视频页面添加下载面板，支持获取视频下载链接" }
)

foreach ($s in $scripts) {
    Write-Host "正在上传: $($s.name)"
    
    $formData = @{
        file = Get-Item -Path $s.file
        name = $s.name
        category_id = $s.cat
        description = $s.desc
    }
    
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/api/scripts" -Method Post -Headers @{
            Authorization = "Bearer $token"
        } -Form $formData
        
        if ($response.success) {
            Write-Host "成功: $($s.name) (ID: $($response.data.id))"
        } else {
            Write-Host "失败: $($s.name) - $($response.error)"
        }
    } catch {
        Write-Host "异常: $($s.name) - $($_.Exception.Message)"
    }
    
    Start-Sleep -Milliseconds 500
}

Write-Host "批量上传完成！"