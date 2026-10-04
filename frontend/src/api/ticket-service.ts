import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 工作票专用流转服务。工作票不走 local-service 的通用动作通道，状态只能顺着
// 「已签发 → 已许可 → 已终结」往下流转：没许可的票不许出现终结记录，跳环改状态一律挡回，
// 并在返回消息里写清卡在哪一环；已终结的票只做归档，回不到许可环节。
export const TICKET_KEY = 'ticket'
const STATION_KEY = 'station'
const STATION_OUTAGE_STATUS = '停运检修'

export const TICKET_STATUS = {
  issued: '已签发',
  permitted: '已许可',
  closed: '已终结',
} as const

export type IssueInput = {
  票号: string
  所属电站: string
  工作负责人: string
  工作任务: string
  安全措施: string
}

export type StationOption = {
  code: string
  name: string
  status: string
}

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ticketRows(): EntryRow[] {
  return listRows(TICKET_KEY)
}

function findStation(code: string): EntryRow | undefined {
  return listRows(STATION_KEY).find((row) => String(row['电站编号']) === code)
}

export function listStationOptions(): StationOption[] {
  return listRows(STATION_KEY).map((row) => ({
    code: String(row['电站编号']),
    name: String(row['电站名称']),
    status: String(row.status),
  }))
}

// 签发新票。票号在同一电站内唯一：同一张票重复提交两次签发只生效一次，第二次按幂等处理不再建票。
// 安全措施栏留白的整票退回重填。
export function issueTicket(input: IssueInput): ActionResult {
  const ticketNo = input.票号.trim()
  const stationCode = input.所属电站.trim()
  const safety = input.安全措施.trim()
  if (!ticketNo) {
    return { ok: false, message: '票号空白，整票退回重填' }
  }
  if (!stationCode) {
    return { ok: false, message: '所属电站未选择，整票退回重填' }
  }
  if (!findStation(stationCode)) {
    return { ok: false, message: `所属电站 ${stationCode} 未登记，整票退回重填` }
  }
  const rows = ticketRows()
  const duplicated = rows.find(
    (row) => String(row['所属电站']) === stationCode && String(row['票号']) === ticketNo,
  )
  if (duplicated) {
    return {
      ok: true,
      message: `票号 ${ticketNo} 在电站 ${stationCode} 已签发过（签发时间 ${duplicated['签发时间']}），重复提交只生效一次，本次不再建票`,
    }
  }
  if (!safety) {
    return { ok: false, message: '安全措施栏空白，整票退回重填' }
  }
  const issuedAt = now()
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const created: EntryRow = {
    id,
    status: TICKET_STATUS.issued,
    pending: true,
    abnormal: false,
    票号: ticketNo,
    所属电站: stationCode,
    工作负责人: input.工作负责人.trim(),
    工作任务: input.工作任务.trim(),
    安全措施: safety,
    签发时间: issuedAt,
    许可时间: '',
    终结时间: '',
    处置结论: '',
    归档编号: '',
  }
  saveRows(TICKET_KEY, [...rows, created])
  return { ok: true, message: `工作票 ${ticketNo} 已签发（${issuedAt}），当前状态「已签发」，待办理许可` }
}

// 许可：只有「已签发」的票能许可；电站必须先处于停运检修（电站那边没就位就不放行）。
export function permitTicket(id: number): ActionResult {
  const rows = ticketRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工作票` }
  }
  const ticket = rows[index]
  const ticketNo = String(ticket['票号'])
  const status = String(ticket.status)
  if (status === TICKET_STATUS.permitted) {
    return { ok: false, message: `票号 ${ticketNo} 已走过「许可」环节（许可时间 ${ticket['许可时间']}），不必重复许可` }
  }
  if (status === TICKET_STATUS.closed) {
    return { ok: false, message: `票号 ${ticketNo} 已终结归档（归档编号 ${ticket['归档编号']}），归档票只做归档，回不到「许可」环节` }
  }
  const stationCode = String(ticket['所属电站'])
  const station = findStation(stationCode)
  if (!station) {
    return { ok: false, message: `票号 ${ticketNo} 登记的所属电站 ${stationCode} 不存在，「许可」不放行` }
  }
  if (String(station.status) !== STATION_OUTAGE_STATUS) {
    return { ok: false, message: `电站那边没就位：${stationCode} 当前状态「${station.status}」，未处于停运检修，「许可」不放行` }
  }
  const permittedAt = now()
  const next = [...rows]
  next[index] = { ...ticket, status: TICKET_STATUS.permitted, 许可时间: permittedAt }
  saveRows(TICKET_KEY, next)
  reconcileAllStationLedgers()
  return { ok: true, message: `票号 ${ticketNo} 已许可（${permittedAt}），许可记录已挂到 ${stationCode} 的停运检修记录` }
}

// 终结：只有「已许可」的票能终结，终结结论必填并落到电站停运检修的待办台账；
// 终结后归档，不再回到任何前序环节。
export function closeTicket(id: number, conclusion: string): ActionResult {
  const rows = ticketRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的工作票` }
  }
  const ticket = rows[index]
  const ticketNo = String(ticket['票号'])
  const status = String(ticket.status)
  if (status === TICKET_STATUS.issued) {
    return { ok: false, message: `没许可的票不许出现终结记录：票号 ${ticketNo} 卡在「许可」环节，请先办理许可` }
  }
  if (status === TICKET_STATUS.closed) {
    return { ok: false, message: `票号 ${ticketNo} 已终结归档（归档编号 ${ticket['归档编号']}），不再重复终结` }
  }
  const text = conclusion.trim()
  if (!text) {
    return { ok: false, message: '终结结论空白，先补填结论再办理终结' }
  }
  const stationCode = String(ticket['所属电站'])
  const station = findStation(stationCode)
  if (!station) {
    return { ok: false, message: `票号 ${ticketNo} 登记的所属电站 ${stationCode} 不存在，「终结」不放行` }
  }
  if (String(station.status) !== STATION_OUTAGE_STATUS) {
    return { ok: false, message: `电站那边没就位：${stationCode} 当前状态「${station.status}」，未处于停运检修，「终结」不放行` }
  }
  const closedAt = now()
  const archiveNo = `GD-${ticketNo}`
  const next = [...rows]
  next[index] = {
    ...ticket,
    status: TICKET_STATUS.closed,
    pending: false,
    终结时间: closedAt,
    处置结论: text,
    归档编号: archiveNo,
  }
  saveRows(TICKET_KEY, next)
  reconcileAllStationLedgers()
  return { ok: true, message: `票号 ${ticketNo} 已终结（${closedAt}），归档编号 ${archiveNo}，结论已落到 ${stationCode} 的停运检修待办台账` }
}

// 电站停运检修台账是工作票的派生视图：许可/终结记录与待办台账都由票上的数据重算出来，
// 两边读的本来就是同一份处置口径。两处时间打架时以工作票上的时间为准——票是操作发生当时
// 留下的原始凭证，台账只是汇总投影；不一致时按票重算台账（本函数即对账入口）。
export function reconcileAllStationLedgers(): void {
  const stations = listRows(STATION_KEY)
  if (stations.length === 0) {
    return
  }
  const tickets = ticketRows()
  const byStation = new Map<string, EntryRow[]>()
  for (const ticket of tickets) {
    const code = String(ticket['所属电站'])
    const list = byStation.get(code) ?? []
    list.push(ticket)
    byStation.set(code, list)
  }
  let changed = false
  const next = stations.map((station) => {
    const { record, todos } = projectLedger(byStation.get(String(station['电站编号'])) ?? [])
    if (station['停运检修记录'] === record && station['待办台账'] === todos) {
      return station
    }
    changed = true
    return { ...station, 停运检修记录: record, 待办台账: todos }
  })
  if (changed) {
    saveRows(STATION_KEY, next)
  }
}

function projectLedger(tickets: EntryRow[]): { record: string; todos: string } {
  const events: { time: string; text: string }[] = []
  const todoItems: string[] = []
  for (const ticket of tickets) {
    const ticketNo = String(ticket['票号'])
    const permittedAt = String(ticket['许可时间'] ?? '').trim()
    const closedAt = String(ticket['终结时间'] ?? '').trim()
    if (permittedAt) {
      events.push({ time: permittedAt, text: `${permittedAt} 许可 ${ticketNo}` })
    }
    if (closedAt) {
      events.push({ time: closedAt, text: `${closedAt} 终结 ${ticketNo}` })
    }
    if (String(ticket.status) === TICKET_STATUS.closed && String(ticket['处置结论'] ?? '').trim()) {
      todoItems.push(`${ticketNo}：${String(ticket['处置结论']).trim()}`)
    }
  }
  events.sort((a, b) => a.time.localeCompare(b.time))
  return {
    record: events.map((event) => event.text).join('；') || '—',
    todos: todoItems.join('；') || '—',
  }
}
