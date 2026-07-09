/**
 * 验证 webmsxyw-node.js 模块
 */
const { init, sign, generateHeaders, decodeXYW, needsCommon } = require('./webmsxyw-node');

async function main() {
  console.log('===== 初始化 =====');
  await init();
  console.log('isReady:', true);

  console.log('\n===== 测试签名生成 =====');
  
  // 搜索 API
  const searchBody = { keyword: '美食', page: 1, page_size: 20 };
  const searchSig = generateHeaders('/api/sns/web/v1/search/notes', searchBody);
  console.log('\nsearch 签名:');
  console.log('  X-s (前60):', searchSig['X-s'].substring(0, 60) + '...');
  console.log('  X-t:', searchSig['X-t']);
  console.log('  长度:', searchSig['X-s'].length);
  
  const decoded = decodeXYW(searchSig['X-s']);
  console.log('  解码:', JSON.stringify(decoded).substring(0, 150));

  // Feed API
  const feedBody = { source_note_id: '6970c05c000000000b0091ca' };
  const feedSig = generateHeaders('/api/sns/web/v1/feed', feedBody);
  console.log('\nfeed 签名:');
  console.log('  X-s (前60):', feedSig['X-s'].substring(0, 60) + '...');
  const feedDecoded = decodeXYW(feedSig['X-s']);
  console.log('  解码:', JSON.stringify(feedDecoded).substring(0, 150));

  // commonPatch 检查
  console.log('\n===== commonPatch 检查 =====');
  console.log('search 需要 x-s-common:', needsCommon('/api/sns/web/v1/search/notes'));
  console.log('feed 需要 x-s-common:', needsCommon('/api/sns/web/v1/feed'));
  console.log('comment 需要 x-s-common:', needsCommon('/api/sns/web/v2/comment/list'));

  // 幂等性测试
  console.log('\n===== 幂等性测试 =====');
  const sig1 = sign('/api/sns/web/v1/search/notes', searchBody);
  const sig2 = sign('/api/sns/web/v1/search/notes', searchBody);
  console.log('相同输入两次调用结果相同:', sig1['X-s'] === sig2['X-s']);
  console.log('sig1 payload 前40:', decodeXYW(sig1['X-s']).payload.substring(0, 40));
  console.log('sig2 payload 前40:', decodeXYW(sig2['X-s']).payload.substring(0, 40));

  // 性能测试
  console.log('\n===== 性能测试 =====');
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    sign('/api/sns/web/v1/search/notes', { keyword: `test${i}`, page: 1 });
  }
  const elapsed = Date.now() - start;
  console.log(`100次签名耗时: ${elapsed}ms (平均 ${elapsed/100}ms/次)`);

  console.log('\n===== 验证通过 =====');
}

main().catch(e => console.error('Error:', e));
