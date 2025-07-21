async function sequentialCombine(urls, destination) {
  try {
    // 按顺序处理每个URL
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      // 获取当前片段
      console.log(url);
      const response = await fetch(url, {
        headers: {
          'Accept-Encoding': 'identity',
        },
      });

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

// 新增：高效处理 Range 请求的函数
async function handleRangeStream(context, fileInfo, fileName, urls) {
  const rangeHeader = context.request.headers.get('range');
  const totalSize = fileInfo.metadata.size;
  let rangeStart = 0, rangeEnd = totalSize - 1;
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) rangeStart = parseInt(match[1]);
      if (match[2]) rangeEnd = parseInt(match[2]);
    }
  }
  if (rangeStart > rangeEnd || rangeEnd >= totalSize) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        'Content-Range': `bytes */${totalSize}`,
      },
    });
  }
  // 计算涉及的 chunk
  const chunkSizes = fileInfo.metadata.chunksSize;
  let acc = 0;
  let startChunk = 0, endChunk = 0, startOffset = 0, endOffset = 0;
  for (let i = 0; i < chunkSizes.length; i++) {
    if (rangeStart >= acc && rangeStart < acc + chunkSizes[i]) {
      startChunk = i;
      startOffset = rangeStart - acc;
    }
    if (rangeEnd >= acc && rangeEnd < acc + chunkSizes[i]) {
      endChunk = i;
      endOffset = rangeEnd - acc;
      break;
    }
    acc += chunkSizes[i];
  }
  // 只传递涉及的 chunk url
  const rangeUrls = urls.slice(startChunk, endChunk + 1);
  // 新实现：拼接流，fetch 时带 Range header
  const rangeReadable = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < rangeUrls.length; i++) {
        let fetchRange = undefined;
        if (startChunk === endChunk) {
          // 只涉及一个 chunk
          fetchRange = `bytes=${startOffset}-${endOffset}`;
        } else if (i === 0) {
          // 首 chunk
          fetchRange = `bytes=${startOffset}-`;
        } else if (i === rangeUrls.length - 1) {
          // 尾 chunk
          fetchRange = `bytes=0-${endOffset}`;
        }
        const headers = { 'Accept-Encoding': 'identity' };
        if (fetchRange) headers['Range'] = fetchRange;
        const resp = await fetch(rangeUrls[i], { headers });
        if (!resp.ok && resp.status !== 206) {
          controller.error(new Error(`fetch chunk failed: ${rangeUrls[i]}`));
          return;
        }
        const reader = resp.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          let chunk = value;
          if (!(chunk instanceof Uint8Array)) {
            chunk = new Uint8Array(chunk);
          }
          controller.enqueue(chunk);
        }
        reader.releaseLock();
      }
      controller.close();
    }
  });
  return new Response(rangeReadable, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename=' + fileName,
      'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${totalSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': rangeEnd - rangeStart + 1,
    },
  });
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
    const configResp = await fetch(configUrl, {
      headers: {
        'Accept-Encoding': 'identity',
      },
    });
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
    // 判断是否为 Range 请求
    if (context.request.headers.get('range')) {
      return await handleRangeStream(context, fileInfo, fileName, urls);
    }
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