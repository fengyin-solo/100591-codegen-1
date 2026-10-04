import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult, TicketDraft } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 工作票状态机：只能顺着 签发→许可→终结→归档 往下走，已终结的票只许归档，回不到许可。
const TICKET_KEY = 'ticket'
const TICKET_FLOW = ['已签发', '已许可', '已终结', '已归档']
// 每一环的名字与进入该环的动作，挡回信息里要写清卡在哪一环。
const TICKET_STEP: Record<string, { label: string; action: string }> = {
  已许可: { label: '许可', action: '许可开工' },
  已终结: { label: '终结', action: '办理终结' },
  已归档: { label: '归档', action: '归档' },
}

function formatNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function findStation(stationKey: string): EntryRow | undefined {
  return listRows('station').find((row) => row.电站编号 === stationKey || row.电站名称 === stationKey)
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 签发工作票：票号在同一电站内唯一；同一张票重复提交只生效一次；安全措施栏空白的整票退回重填。
export function issueTicket(draft: TicketDraft): ActionResult {
  const ticketNo = draft.票号.trim()
  const stationKey = draft.所属电站.trim()
  if (!ticketNo || !stationKey) {
    return { ok: false, message: '票号、所属电站不能为空，整票退回重填' }
  }
  if (!draft.安全措施.trim()) {
    return { ok: false, message: `工作票${ticketNo}安全措施栏留着空白，整票退回重填` }
  }
  if (!findStation(stationKey)) {
    return { ok: false, message: `电站${stationKey}没有登记，工作票${ticketNo}签不出去` }
  }
  const rows = listRows(TICKET_KEY)
  const duplicated = rows.find((row) => row.票号 === ticketNo && row.所属电站 === stationKey)
  if (duplicated) {
    const sameContent = (['工作内容', '工作负责人', '签发人', '许可人', '安全措施', '计划开工'] as const).every(
      (field) => String(duplicated[field] ?? '') === draft[field].trim(),
    )
    if (sameContent) {
      return { ok: true, message: `工作票${ticketNo}已签发，重复提交只生效一次，未再开新票` }
    }
    return { ok: false, message: `票号${ticketNo}在电站${stationKey}内已使用，同一电站内票号唯一` }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const row: EntryRow = {
    id,
    status: '已签发',
    pending: true,
    abnormal: false,
    票号: ticketNo,
    所属电站: stationKey,
    工作内容: draft.工作内容.trim(),
    工作负责人: draft.工作负责人.trim(),
    签发人: draft.签发人.trim(),
    许可人: draft.许可人.trim(),
    安全措施: draft.安全措施.trim(),
    计划开工: draft.计划开工.trim(),
    许可时间: '',
    终结时间: '',
    终结结论: '',
    票面状态: '已签发',
  }
  saveRows(TICKET_KEY, [...rows, row])
  return { ok: true, message: `工作票${ticketNo}已签发，待电站停运检修就位后许可开工` }
}

// 工作票流转：只许顺着签发、许可、终结、归档往下走；许可与终结要挂到电站的停运检修记录上，
// 电站没就位就不放行；终结结论同步落到电站的检修待办台账，两边读到的口径一致。
function runTicketAction(meta: ModuleMeta, rows: EntryRow[], index: number, action: string, target: string, extra?: Record<string, string>): ActionResult {
  const row = rows[index]
  const from = TICKET_FLOW.indexOf(String(row.status))
  const to = TICKET_FLOW.indexOf(target)
  if (to < from) {
    return { ok: false, message: `工作票${row.票号}当前「${row.status}」，流程只能顺着签发、许可、终结往下走，回不到「${TICKET_STEP[target]?.label ?? target}」这一环` }
  }
  if (to > from + 1) {
    const missing = TICKET_STEP[TICKET_FLOW[from + 1]]
    return { ok: false, message: `工作票${row.票号}卡在「${missing.label}」环节：先${missing.action}，才能${action}，跳环一律挡回` }
  }
  if (target === '已许可' || target === '已终结') {
    const station = findStation(String(row.所属电站))
    if (!station) {
      return { ok: false, message: `工作票${row.票号}的所属电站${row.所属电站}没有登记，${TICKET_STEP[target].label}环节不放行` }
    }
    if (station.status !== '停运检修') {
      return { ok: false, message: `电站${station.电站名称}当前「${station.status}」，停运检修未就位，${TICKET_STEP[target].label}环节不放行` }
    }
  }
  const updated: EntryRow = { ...row, status: target, 票面状态: target, pending: target !== '已归档', abnormal: false }
  if (target === '已许可') {
    updated.许可时间 = formatNow()
  }
  if (target === '已终结') {
    const conclusion = String(extra?.['终结结论'] ?? '').trim()
    if (!conclusion) {
      return { ok: false, message: `工作票${row.票号}终结结论不能为空，终结未办理` }
    }
    const finishedAt = formatNow()
    updated.终结时间 = finishedAt
    updated.终结结论 = conclusion
    // 终结结论落到电站停运检修的待办台账。两处时间若打架，以工作票上的终结时间为准：
    // 票是原始凭证，台账只是照抄票面，不另记一份自己的钟点。
    const entry = `工作票${row.票号}已终结：${conclusion}（终结时间 ${finishedAt}）`
    const stations = listRows('station')
    const stationIndex = stations.findIndex((item) => item.电站编号 === row.所属电站 || item.电站名称 === row.所属电站)
    const ledger = String(stations[stationIndex].检修待办 ?? '').trim()
    stations[stationIndex] = {
      ...stations[stationIndex],
      检修待办: ledger && ledger !== '无' ? `${ledger}；${entry}` : entry,
    }
    saveRows('station', stations)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(meta.key, next)
  return { ok: true, message: `工作票${row.票号}已${action}，当前状态「${target}」` }
}

export function runAction(key: string, id: number, action: string, extra?: Record<string, string>): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (key === TICKET_KEY) {
    return runTicketAction(meta, rows, index, action, target, extra)
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
