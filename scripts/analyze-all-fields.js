#!/usr/bin/env node

/**
 * 分析所有消息类型的完整字段列表
 * 生成 Swift 模型所需的字段定义
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');

// 按类型收集所有字段
const typeFields = new Map();

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      analyzeFile(fullPath);
    }
  }
}

function analyzeFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const type = msg.type || '<no-type>';

        if (!typeFields.has(type)) {
          typeFields.set(type, new Map());
        }

        const fields = typeFields.get(type);

        for (const [key, value] of Object.entries(msg)) {
          if (!fields.has(key)) {
            fields.set(key, {
              count: 0,
              types: new Set(),
              samples: new Set(),
            });
          }

          const fieldInfo = fields.get(key);
          fieldInfo.count++;

          const valueType = Array.isArray(value) ? 'array' : typeof value;
          fieldInfo.types.add(valueType);

          // 收集样本值
          if (typeof value === 'string' && fieldInfo.samples.size < 20) {
            fieldInfo.samples.add(value.substring(0, 100));
          } else if (typeof value === 'boolean' || typeof value === 'number') {
            if (fieldInfo.samples.size < 10) {
              fieldInfo.samples.add(value);
            }
          }
        }
      } catch (e) {
        // skip
      }
    }
  } catch (e) {
    // skip
  }
}

function generateSwiftModel() {
  console.log('=================================================');
  console.log('Swift Message Model - 完整字段定义');
  console.log('=================================================\n');

  for (const [type, fields] of typeFields.entries()) {
    console.log(`\n// ============================================`);
    console.log(`// Type: ${type}`);
    console.log(`// ============================================\n`);

    const sortedFields = Array.from(fields.entries())
      .sort((a, b) => b[1].count - a[1].count);

    for (const [fieldName, fieldInfo] of sortedFields) {
      const percentage = ((fieldInfo.count / getTotalCount(type)) * 100).toFixed(1);
      const types = Array.from(fieldInfo.types);
      const swiftType = inferSwiftType(types, fieldInfo.samples);
      const isOptional = percentage < 100;

      console.log(`// ${fieldName} (${percentage}%)`);
      console.log(`let ${fieldName}: ${swiftType}${isOptional ? '?' : ''}`);

      // 显示样本值（如果有特殊含义）
      if (['subtype', 'operation', 'level', 'role'].includes(fieldName)) {
        const samples = Array.from(fieldInfo.samples).slice(0, 10);
        if (samples.length > 0) {
          console.log(`// 可能的值: ${samples.join(', ')}`);
        }
      }

      console.log('');
    }
  }
}

function getTotalCount(type) {
  let total = 0;
  for (const line of getAllMessages()) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === type) total++;
    } catch (e) {}
  }
  return total || 1;
}

function* getAllMessages() {
  // 简化实现，直接从统计数据推断
  return;
}

function inferSwiftType(types, samples) {
  if (types.length === 1) {
    const type = types[0];
    switch (type) {
      case 'string': return 'String';
      case 'number': return 'Int';
      case 'boolean': return 'Bool';
      case 'object': return 'JSONObject';
      case 'array': return '[JSONValue]';
      default: return 'JSONValue';
    }
  }

  // 多种类型，使用 JSONValue
  return 'JSONValue';
}

console.log('🔍 开始扫描...\n');
scanDirectory(CLAUDE_PROJECTS_PATH);
generateSwiftModel();
