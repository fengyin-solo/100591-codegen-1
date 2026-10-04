// 工作票流转规则的功能验证：在 Node 里跑（local-store 对无 window 环境有内存兜底）。
import assert from 'node:assert'

import { runAction } from '@/api/local-service'
import {
  closeTicket,
  issueTicket,
  permitTicket,
  reconcileAllStationLedgers,
  TICKET_KEY,
} from '@/api/ticket-service'
import { listRows, saveRows } from '@/data/local-store'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

const station = (code: string) => listRows('station').find((r) => r['电站编号'] === code)!
const ticketByNo = (no: string) => listRows(TICKET_KEY).find((r) => r['票号'] === no)

// 1. 正常签发
check('签发新票成功，状态为已签发', () => {
  const r = issueTicket({ 票号: 'GZP-2026-0100', 所属电站: 'STAT-0003', 工作负责人: '张三', 工作任务: '箱变检修', 安全措施: '断开箱变高低压侧开关，挂接地线' })
  assert.equal(r.ok, true, r.message)
  assert.equal(ticketByNo('GZP-2026-0100')!.status, '已签发')
})

// 2. 重复提交签发只生效一次
check('同票号同电站重复签发幂等，只建一张票', () => {
  const before = listRows(TICKET_KEY).length
  const r = issueTicket({ 票号: 'GZP-2026-0100', 所属电站: 'STAT-0003', 工作负责人: '张三', 工作任务: '箱变检修', 安全措施: '断开箱变高低压侧开关，挂接地线' })
  assert.equal(r.ok, true)
  assert.match(r.message, /只生效一次/)
  assert.equal(listRows(TICKET_KEY).length, before)
})

// 3. 安全措施空白整票退回
check('安全措施栏空白整票退回重填', () => {
  const r = issueTicket({ 票号: 'GZP-2026-0101', 所属电站: 'STAT-0003', 工作负责人: '李四', 工作任务: '组件更换', 安全措施: '   ' })
  assert.equal(r.ok, false)
  assert.match(r.message, /安全措施栏空白.*退回重填/)
  assert.equal(ticketByNo('GZP-2026-0101'), undefined)
})

// 4. 票号唯一性按电站隔离：不同电站可用同票号
check('票号在同一电站内唯一、跨电站可复用', () => {
  const r = issueTicket({ 票号: 'GZP-2026-0100', 所属电站: 'STAT-0002', 工作负责人: '王五', 工作任务: '除草', 安全措施: '设围栏' })
  assert.equal(r.ok, true, r.message)
})

// 5. 没许可的票不许终结，消息写清卡在许可环节
check('未许可直接终结被挡回并指明卡在许可环节', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = closeTicket(Number(t.id), '想提前终结')
  assert.equal(r.ok, false)
  assert.match(r.message, /卡在「许可」环节/)
  assert.equal(ticketByNo('GZP-2026-0100')!['终结时间'], '')
})

// 6. 电站没就位（非停运检修）许可不放行
check('电站未处于停运检修时许可不放行', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0002')!
  const r = permitTicket(Number(t.id))
  assert.equal(r.ok, false)
  assert.match(r.message, /没就位.*运行中.*不放行/)
})

// 7. 电站就位后许可成功，且许可记录挂到电站停运检修记录
check('电站停运检修中就位后许可成功并挂到电站记录', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = permitTicket(Number(t.id))
  assert.equal(r.ok, true, r.message)
  assert.equal(ticketByNo('GZP-2026-0100')!.status, '已许可')
  assert.match(String(station('STAT-0003')['停运检修记录']), /许可 GZP-2026-0100/)
})

// 8. 重复许可挡回
check('已许可的票重复许可被挡回', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = permitTicket(Number(t.id))
  assert.equal(r.ok, false)
  assert.match(r.message, /不必重复许可/)
})

// 9. 终结成功：归档编号生成，结论落到电站待办台账
check('终结后归档，结论落到电站停运检修待办台账', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = closeTicket(Number(t.id), '箱变检修完成，已恢复送电')
  assert.equal(r.ok, true, r.message)
  const done = ticketByNo('GZP-2026-0100')!
  assert.equal(done.status, '已终结')
  assert.equal(done['归档编号'], 'GD-GZP-2026-0100')
  assert.equal(done.pending, false)
  assert.match(String(station('STAT-0003')['待办台账']), /GZP-2026-0100：箱变检修完成，已恢复送电/)
})

// 10. 已终结的票回不到许可环节
check('已终结归档的票回不到许可环节', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = permitTicket(Number(t.id))
  assert.equal(r.ok, false)
  assert.match(r.message, /回不到「许可」环节/)
})

// 11. 重复终结挡回
check('已终结的票不再重复终结', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  const r = closeTicket(Number(t.id), '再次终结')
  assert.equal(r.ok, false)
  assert.match(r.message, /不再重复终结/)
})

// 12. 两处时间打架时以票为准：手工改乱电站台账，对账后按票重算
check('电站台账时间与票不一致时按票重算（以票为准）', () => {
  const stations = listRows('station').map((s) =>
    s['电站编号'] === 'STAT-0003' ? { ...s, 停运检修记录: '1999-01-01 00:00 许可 GZP-2026-0100', 待办台账: '乱写的口径' } : s,
  )
  saveRows('station', stations)
  reconcileAllStationLedgers()
  const record = String(station('STAT-0003')['停运检修记录'])
  assert.ok(!record.includes('1999-01-01'), '台账里的旧时间应被票上时间覆盖')
  const ticket = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0100' && r['所属电站'] === 'STAT-0003')!
  assert.ok(record.includes(String(ticket['许可时间'])), '台账许可时间应与票上一致')
  assert.match(String(station('STAT-0003')['待办台账']), /箱变检修完成，已恢复送电/)
})

// 13. 通用动作通道不许改工作票状态
check('通用 runAction 通道对工作票一律挡回', () => {
  const t = listRows(TICKET_KEY).find((r) => r['票号'] === 'GZP-2026-0004')!
  const r = runAction(TICKET_KEY, Number(t.id), '办理终结')
  assert.equal(r.ok, false)
  assert.match(r.message, /签发→许可→终结/)
  assert.equal(ticketByNo('GZP-2026-0004')!.status, '已签发')
})

// 14. 终结结论空白不放行
check('终结结论空白不放行', () => {
  const t = ticketByNo('GZP-2026-0002')!
  const r = closeTicket(Number(t.id), '   ')
  assert.equal(r.ok, false)
  assert.match(r.message, /结论空白/)
})

console.log(`\n${passed} 项检查全部通过`)
