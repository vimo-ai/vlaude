#!/usr/bin/env node

/**
 * JSONL 消息结构深度分析脚本
 *
 * 功能：
 * 1. 分析每个 type 下的详细结构
 * 2. 识别子类型、特殊字段
 * 3. 采样显示实际数据
 *
 * 使用方式：
 *   node scripts/analyze-jsonl-structure.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 配置
const CLAUDE_PROJECTS_PATH = path.join(os.homedir(), '.claude', 'projects');
const SAMPLE_SIZE = 3; // 每种类型采样数量

// 统计数据
const typeStructures = new Map(); // type -> { fields: Map, samples: [] }

/**
 * 递归扫描目录
 */
function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      analyzeJsonlFile(fullPath);
    }
  }
}

/**
 * 分析 JSONL 文件
 */
function analyzeJsonlFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        const type = message.type || '<no-type>';

        if (!typeStructures.has(type)) {
          typeStructures.set(type, {
            fields: new Map(),
            samples: [],
            totalCount: 0,
          });
        }

        const typeData = typeStructures.get(type);
        typeData.totalCount++;

        // 收集字段统计
        for (const [key, value] of Object.entries(message)) {
          if (!typeData.fields.has(key)) {
            typeData.fields.set(key, {
              count: 0,
              valueTypes: new Set(),
              sampleValues: new Set(),
            });
          }

          const fieldData = typeData.fields.get(key);
          fieldData.count++;
          fieldData.valueTypes.add(typeof value);

          // 收集样本值（对于字符串类型）
          if (typeof value === 'string' && fieldData.sampleValues.size < 10) {
            fieldData.sampleValues.add(value.substring(0, 100));
          } else if (typeof value === 'object' && value !== null) {
            // 对于对象，记录其 keys
            fieldData.sampleValues.add(`{${Object.keys(value).join(', ')}}`);
          }
        }

        // 收集样本（限制数量）
        if (typeData.samples.length < SAMPLE_SIZE) {
          // 深拷贝并截断长字段
          const sample = {};
          for (const [key, value] of Object.entries(message)) {
            if (typeof value === 'string') {
              sample[key] = value.length > 200 ? value.substring(0, 200) + '...' : value;
            } else if (Array.isArray(value)) {
              sample[key] = `[Array(${value.length})]`;
            } else if (typeof value === 'object' && value !== null) {
              sample[key] = `{${Object.keys(value).join(', ')}}`;
            } else {
              sample[key] = value;
            }
          }
          typeData.samples.push(sample);
        }
      } catch (parseError) {
        // 跳过解析错误
      }
    }
  } catch (error) {
    // 跳过文件读取错误
  }
}

/**
 * 生成详细报告
 */
function generateReport() {
  console.log('\n=================================================');
  console.log('🔬 JSONL 消息结构深度分析报告');
  console.log('=================================================\n');

  // 按出现次数排序
  const sortedTypes = Array.from(typeStructures.entries())
    .sort((a, b) => b[1].totalCount - a[1].totalCount);

  for (const [type, data] of sortedTypes) {
    console.log(`\n📦 类型: ${type}`);
    console.log(`   总数: ${data.totalCount} 条\n`);

    // 字段统计
    console.log('   字段列表:');
    const sortedFields = Array.from(data.fields.entries())
      .sort((a, b) => b[1].count - a[1].count);

    for (const [field, fieldData] of sortedFields) {
      const percentage = ((fieldData.count / data.totalCount) * 100).toFixed(1);
      const types = Array.from(fieldData.valueTypes).join(', ');
      console.log(`   - ${field.padEnd(25)} (${percentage.padStart(5)}%) [${types}]`);

      // 显示样本值（如果有特殊含义）
      if (field === 'role' || field === 'name' || field === 'status') {
        const samples = Array.from(fieldData.sampleValues).slice(0, 5);
        if (samples.length > 0) {
          console.log(`     样本: ${samples.join(', ')}`);
        }
      }
    }

    // 显示样本数据
    console.log('\n   样本数据:');
    for (let i = 0; i < data.samples.length; i++) {
      console.log(`\n   样本 ${i + 1}:`);
      console.log('   ' + JSON.stringify(data.samples[i], null, 2).split('\n').join('\n   '));
    }

    console.log('\n' + '─'.repeat(70));
  }

  console.log('\n=================================================\n');
}

/**
 * 查找子类型特征
 */
function analyzeSubTypes() {
  console.log('\n🔍 子类型特征分析:\n');

  for (const [type, data] of typeStructures.entries()) {
    const potentialSubTypeFields = [];

    // 查找可能是子类型标识的字段
    for (const [field, fieldData] of data.fields.entries()) {
      // 如果字段值是字符串且有多个不同值，可能是子类型
      if (fieldData.valueTypes.has('string') && fieldData.sampleValues.size > 1 && fieldData.sampleValues.size < 20) {
        potentialSubTypeFields.push({
          field,
          values: Array.from(fieldData.sampleValues),
        });
      }
    }

    if (potentialSubTypeFields.length > 0) {
      console.log(`📌 类型 "${type}" 可能的子类型字段:`);
      for (const item of potentialSubTypeFields) {
        console.log(`   - ${item.field}:`);
        for (const value of item.values.slice(0, 10)) {
          console.log(`     • ${value}`);
        }
      }
      console.log('');
    }
  }
}

/**
 * 主函数
 */
function main() {
  console.log('🔍 开始扫描 JSONL 文件...');
  console.log(`📂 扫描目录: ${CLAUDE_PROJECTS_PATH}\n`);

  if (!fs.existsSync(CLAUDE_PROJECTS_PATH)) {
    console.error(`❌ 目录不存在: ${CLAUDE_PROJECTS_PATH}`);
    process.exit(1);
  }

  scanDirectory(CLAUDE_PROJECTS_PATH);
  generateReport();
  analyzeSubTypes();

  // 保存详细结构数据
  const reportPath = path.join(__dirname, 'jsonl-structure-report.json');
  const reportData = {};

  for (const [type, data] of typeStructures.entries()) {
    reportData[type] = {
      totalCount: data.totalCount,
      fields: Object.fromEntries(
        Array.from(data.fields.entries()).map(([field, fieldData]) => [
          field,
          {
            count: fieldData.count,
            percentage: ((fieldData.count / data.totalCount) * 100).toFixed(2),
            types: Array.from(fieldData.valueTypes),
            sampleValues: Array.from(fieldData.sampleValues).slice(0, 20),
          },
        ])
      ),
      samples: data.samples,
    };
  }

  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`\n📄 详细结构数据已保存到: ${reportPath}\n`);
}

// 执行
main();
