#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const wordPattern = /([A-Za-z])([+-]?(?:\d+\.?\d*|\.\d+))/g

function words(line) {
  const values = new Map()
  const body = line.replace(/\([^)]*\)/g, '').replace(/;.*/, '')
  wordPattern.lastIndex = 0
  let match
  while ((match = wordPattern.exec(body)) !== null) {
    values.set(match[1].toUpperCase(), Number(match[2]))
  }
  return values
}

function motionFrom(values, currentMotion) {
  if (!values.has('G')) return { motion: currentMotion, explicit: false }
  const g = Math.trunc(values.get('G'))
  if ([0, 1, 2, 3].includes(g)) return { motion: `G${String(g).padStart(2, '0')}`, explicit: true }
  return { motion: currentMotion, explicit: false }
}

function auditFile(path) {
  const lines = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n')
  const issues = []
  const warnings = []
  const feeds = new Set()
  const operationDepths = new Map()
  const motionCounts = new Map()
  let currentOperation = '<none>'
  let currentMotion
  let position = { x: 0, y: 0, z: 0 }
  let minCutZ = 0
  let maxStepDown = 0

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index].trim()
    const operationMatch = line.match(/^\((No\.\s*\d+\s+.+)\)$/i)
    if (operationMatch) currentOperation = operationMatch[1]

    const values = words(line)
    if (values.has('F')) feeds.add(values.get('F'))
    const modal = motionFrom(values, currentMotion)
    currentMotion = modal.motion
    const hasAxis = ['X', 'Y', 'Z', 'I', 'J'].some((axis) => values.has(axis))
    if (currentMotion && (modal.explicit || hasAxis)) motionCounts.set(currentMotion, (motionCounts.get(currentMotion) ?? 0) + 1)

    const next = {
      x: values.has('X') ? values.get('X') : position.x,
      y: values.has('Y') ? values.get('Y') : position.y,
      z: values.has('Z') ? values.get('Z') : position.z,
    }

    if ((currentMotion === 'G02' || currentMotion === 'G03') && (values.has('I') || values.has('J'))) {
      const center = { x: position.x + (values.get('I') ?? 0), y: position.y + (values.get('J') ?? 0) }
      const startRadius = Math.hypot(position.x - center.x, position.y - center.y)
      const endRadius = Math.hypot(next.x - center.x, next.y - center.y)
      if (Math.abs(startRadius - endRadius) > 0.02) {
        issues.push(`line ${lineNumber}: arc radius mismatch ${startRadius.toFixed(4)} vs ${endRadius.toFixed(4)}: ${line}`)
      }
    }

    if (currentMotion === 'G00' && values.has('Z') && values.get('Z') < 0) {
      warnings.push(`line ${lineNumber}: rapid Z below stock (${values.get('Z')}): ${line}`)
    }

    if (modal.explicit && currentMotion === 'G00' && values.has('Z') && !values.has('X') && !values.has('Y') && Math.abs(values.get('Z')) < 0.0001 && index < lines.length - 3) {
      issues.push(`line ${lineNumber}: source parking move drops to Z0 before program end: ${line}`)
    }

    if (['G01', 'G02', 'G03'].includes(currentMotion) && next.z < position.z - 0.0001) {
      maxStepDown = Math.max(maxStepDown, position.z - next.z)
    }

    if (['G01', 'G02', 'G03'].includes(currentMotion) && next.z < 0) {
      minCutZ = Math.min(minCutZ, next.z)
      operationDepths.set(currentOperation, Math.min(operationDepths.get(currentOperation) ?? 0, next.z))
    }

    position = next
  }

  return {
    path,
    lines: lines.length,
    issues,
    warnings,
    feeds: [...feeds].sort((a, b) => a - b),
    motions: Object.fromEntries([...motionCounts].sort()),
    minCutZ,
    maxStepDown,
    operationDepths: Object.fromEntries([...operationDepths]),
  }
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('Usage: npm run audit:gcode -- file.nc [file2.nc ...]')
  process.exit(2)
}

let exitCode = 0
for (const path of paths) {
  const result = auditFile(path)
  console.log(`\n${result.path}`)
  console.log(`  lines: ${result.lines}`)
  console.log(`  motions: ${JSON.stringify(result.motions)}`)
  console.log(`  feeds: ${result.feeds.join(', ') || '<none>'}`)
  console.log(`  deepest cutting Z: ${result.minCutZ}`)
  console.log(`  max single step-down: ${Number(result.maxStepDown.toFixed(4))}`)
  console.log(`  operation depths: ${JSON.stringify(result.operationDepths)}`)

  for (const warning of result.warnings) console.log(`  warning: ${warning}`)
  for (const issue of result.issues) console.log(`  error: ${issue}`)

  if (result.issues.length > 0) exitCode = 1
}

process.exit(exitCode)
