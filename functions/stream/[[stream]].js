async function sequentialCombine(urls, destination) {
  try {
    // 按顺序处理每个URL
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      // 获取当前片段
      console.log(url);
      const response = await fetch(url);

      if (!response.ok) {
        console.error(`获取视频片段失败: ${url}, 状态码: ${response.status}`);
        continue;
      }

      // 获取可读流
      const readable = response.body;

      // 立即执行pipeTo，将当前片段写入目标流
      try {
        await readable.pipeTo(destination, {
          preventClose: true, // 保持流开放以便后续写入
        });
      } catch (e) {
        console.error(`流处理错误 (${url}): ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`合并视频流错误: ${err.message}`);
  } finally {
    // 完成所有片段处理后关闭流
    const writer = destination.getWriter();
    writer.close();
    writer.releaseLock();
  }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const host = url.host;
  // 1. 获取 stream 参数
  let fileName = '';
  const stream = context.params.stream;
  if (typeof stream === 'string') {
    fileName = stream;
  } else if (Array.isArray(stream) && stream.length > 0) {
    fileName = stream[0];
  }
  if (!fileName) {
    return new Response('缺少文件名参数', { status: 400 });
  }

  try {
    // 2. 获取 config.json
    const configUrl = `${url.protocol}//${host}/config.json`;
    const configResp = await fetch(configUrl);
    if (!configResp.ok) {
      return new Response('无法获取文件列表', { status: 500 });
    }
    let configObj;
    try {
      configObj = await configResp.json();
    } catch (e) {
      return new Response('配置文件格式错误', { status: 500 });
    }
    const fileInfo = configObj.files && configObj.files[fileName];
    if (!fileInfo) {
      return new Response(JSON.stringify({ error: '404 not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 拼接chunks为完整的urls数组
    const origin = `${url.protocol}//${host}`;
    const urls = fileInfo.chunks.map(chunk => `${origin}/${chunk}`);
    // 创建转换流
    const { readable, writable } = new TransformStream();

    // 按顺序获取并合并视频片段
    sequentialCombine(urls, writable);

    // 返回合并后的视频流响应
    return new Response(readable, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=" + fileName,
        "Content-Length": fileInfo.metadata.size, // 设置内容长度
      },
    });
  } catch (err) {
    return new Response(`Server Error: ${err.message}`, { status: 500 });
  }
}