// ============ 大模型调用记录 ============
let aclPage = 1;
let aclPageSize = 20;
let aclDailyChartInst = null;
let aclModelChartInst = null;

async function initAICallLogs() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  document.getElementById('aclStartDate').value = start.toISOString().slice(0, 10);
  document.getElementById('aclEndDate').value = end.toISOString().slice(0, 10);
  await aclLoadFilters();
  await aclLoadStats();
  await aclLoadList();
  window.addEventListener('resize', aclResizeCharts);
}

function aclResizeCharts() {
  if (aclDailyChartInst) aclDailyChartInst.resize();
  if (aclModelChartInst) aclModelChartInst.resize();
}

function aclQueryParams() {
  return {
    start_date: document.getElementById('aclStartDate').value,
    end_date: document.getElementById('aclEndDate').value,
    model: document.getElementById('aclModelFilter').value,
    provider_id: document.getElementById('aclProviderFilter').value,
    app_key_id: document.getElementById('aclAppKeyFilter').value,
    success: document.getElementById('aclSuccessFilter').value,
    keyword: document.getElementById('aclKeyword').value.trim(),
  };
}

async function aclLoadFilters() {
  try {
    const res = await api('GET', '/api/ai-call-logs/filters');
    if (!res.success) return;
    const d = res.data;
    const ms = document.getElementById('aclModelFilter');
    ms.innerHTML = '<option value="">全部</option>' + d.models.map(m => `<option value="${m}">${m}</option>`).join('');
    const ps = document.getElementById('aclProviderFilter');
    ps.innerHTML = '<option value="">全部</option>' + d.providers.map(p => `<option value="${p.id}">${p.display_name}</option>`).join('');
    const ks = document.getElementById('aclAppKeyFilter');
    ks.innerHTML = '<option value="">全部</option>' + d.appKeys.map(k => `<option value="${k.id}">${k.name || k.id}</option>`).join('');
  } catch (e) { console.error('加载筛选项失败', e); }
}

async function aclLoadStats() {
  try {
    const q = aclQueryParams();
    const res = await api('GET', '/api/ai-call-logs/daily-stats?' + new URLSearchParams(q));
    if (!res.success) return;
    const d = res.data;
    const o = d.overview || {};
    const total = Number(o.total_calls || 0);
    const okCount = Number(o.total_success || 0);
    const failCount = Number(o.total_fail || 0);
    document.getElementById('aclOverview').innerHTML = `
      <div class="stat-card"><div class="stat-label">总调用</div><div class="stat-value">${total}</div></div>
      <div class="stat-card"><div class="stat-label">成功</div><div class="stat-value" style="color:#10b981">${okCount}</div></div>
      <div class="stat-card"><div class="stat-label">失败</div><div class="stat-value" style="color:#ef4444">${failCount}</div></div>
      <div class="stat-card"><div class="stat-label">总 Tokens</div><div class="stat-value">${Number(o.total_tokens || 0).toLocaleString()}</div></div>
      <div class="stat-card"><div class="stat-label">平均耗时(ms)</div><div class="stat-value">${Math.round(o.avg_duration_ms || 0)}</div></div>`;
    aclRenderDailyChart(d.daily || [], d.dailyByModel || []);
    aclRenderModelChart(d.byModel || []);
  } catch (e) { console.error('加载统计失败', e); }
}

function aclRenderDailyChart(daily, dailyByModel) {
  if (typeof echarts === 'undefined') return;
  if (!aclDailyChartInst) aclDailyChartInst = echarts.init(document.getElementById('aclDailyChart'));

  const dates = daily.map(r => r.date);
  const tokens = daily.map(r => Number(r.total_tokens || 0));

  // 从 dailyByModel 构建堆叠柱状图数据
  const modelMap = {};
  dailyByModel.forEach(r => {
    if (!modelMap[r.model]) modelMap[r.model] = {};
    modelMap[r.model][r.date] = Number(r.call_count || 0);
  });

  const colors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#ec4899','#f97316'];
  const modelNames = Object.keys(modelMap).slice(0, 8);
  const barSeries = modelNames.map((model, i) => ({
    name: model,
    type: 'bar',
    stack: 'calls',
    data: dates.map(d => modelMap[model][d] || 0),
    itemStyle: { color: colors[i] },
    barMaxWidth: 40,
  }));

  // 剩余模型合并为"其他"
  if (Object.keys(modelMap).length > 8) {
    const othersMap = {};
    Object.keys(modelMap).slice(8).forEach(m => {
      Object.entries(modelMap[m]).forEach(([d, v]) => {
        othersMap[d] = (othersMap[d] || 0) + v;
      });
    });
    barSeries.push({
      name: '其他',
      type: 'bar',
      stack: 'calls',
      data: dates.map(d => othersMap[d] || 0),
      itemStyle: { color: '#94a3b8' },
      barMaxWidth: 40,
    });
    modelNames.push('其他');
  }

  const allLegend = [...modelNames, '总Token'];

  // 如果没有 dailyByModel，回退到简单的总次数柱状图
  const finalSeries = barSeries.length > 0 ? [
    ...barSeries,
    { name: '总Token', type: 'line', yAxisIndex: 1, data: tokens, smooth: true, itemStyle: { color: '#10b981' } },
  ] : [
    { name: '调用次数', type: 'bar', data: daily.map(r => Number(r.call_count || 0)), itemStyle: { color: '#6366f1' } },
    { name: '总Token', type: 'line', yAxisIndex: 1, data: tokens, smooth: true, itemStyle: { color: '#10b981' } },
  ];

  aclDailyChartInst.setOption({
    tooltip: { trigger: 'axis' },
    legend: { data: barSeries.length > 0 ? allLegend : ['调用次数', '总Token'], top: 0 },
    grid: { left: 50, right: 50, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
    yAxis: [
      { type: 'value', name: '次数', position: 'left' },
      { type: 'value', name: 'Token', position: 'right' },
    ],
    series: finalSeries,
  });
}

function aclRenderModelChart(byModel) {
  if (typeof echarts === 'undefined') return;
  if (!aclModelChartInst) aclModelChartInst = echarts.init(document.getElementById('aclModelChart'));
  const data = byModel.map(r => ({ name: r.model, value: Number(r.call_count || 0) }));
  aclModelChartInst.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { type: 'scroll', orient: 'vertical', right: 10, top: 'middle' },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      center: ['40%', '50%'],
      data: data,
      label: { formatter: '{b}\n{d}%', fontSize: 11 },
    }],
  });
}

async function aclLoadList() {
  const tbody = document.getElementById('aclList');
  tbody.innerHTML = '<tr><td colspan="12" class="empty-state">加载中...</td></tr>';
  try {
    const q = aclQueryParams();
    const params = new URLSearchParams({ page: aclPage, pageSize: aclPageSize, ...q });
    const res = await api('GET', '/api/ai-call-logs?' + params);
    if (!res.success) { tbody.innerHTML = `<tr><td colspan="12" class="empty-state">${res.error || '加载失败'}</td></tr>`; return; }
    const rows = res.data || [];
    const pg = res.pagination || {};
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="empty-state">暂无数据</td></tr>';
    } else {
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td>${new Date(r.created_at).toLocaleString('zh-CN', {hour12:false})}</td>
          <td>${r.model || '-'}</td>
          <td>${r.provider_name || '-'}</td>
          <td>${r.app_key_name || '-'}</td>
          <td>${r.stream ? '流式' : '同步'}</td>
          <td><span class="badge ${r.success ? 'badge-ok' : 'badge-fail'}">${r.success ? '成功' : '失败'}</span></td>
          <td>${r.duration_ms != null ? r.duration_ms : '-'}</td>
          <td>${r.status_code != null ? r.status_code : '-'}</td>
          <td>${r.prompt_tokens != null ? r.prompt_tokens : '-'}</td>
          <td>${r.completion_tokens != null ? r.completion_tokens : '-'}</td>
          <td>${r.total_tokens != null ? r.total_tokens : '-'}</td>
          <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.error_msg||'').replace(/"/g,'&quot;')}">${r.error_msg || ''}</td>
        </tr>`).join('');
    }
    const total = pg.total || 0;
    const totalPages = pg.totalPages || 1;
    document.getElementById('aclPageInfo').textContent = `第 ${aclPage} / ${totalPages} 页，共 ${total} 条`;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-state">加载失败: ${e.message}</td></tr>`;
  }
}

function aclApplyFilter() {
  aclPage = 1;
  aclLoadStats();
  aclLoadList();
}
function aclResetFilter() {
  document.getElementById('aclModelFilter').value = '';
  document.getElementById('aclProviderFilter').value = '';
  document.getElementById('aclAppKeyFilter').value = '';
  document.getElementById('aclSuccessFilter').value = '';
  document.getElementById('aclKeyword').value = '';
  aclApplyFilter();
}
function aclGoPage(p) {
  if (p < 1) return;
  aclPage = p;
  aclLoadList();
}
