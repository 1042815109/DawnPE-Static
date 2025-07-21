const fs = require('fs-extra');

async function copyPublicFolder() {
  try {
    await fs.copy('public', 'dist');
    console.log('public 文件夹已复制到 dist 目录');
  } catch (err) {
    console.error('复制 public 文件夹失败:', err);
  }
}

copyPublicFolder();