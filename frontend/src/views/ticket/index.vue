<template>
  <section class="page" data-module="ticket">
    <header class="page-head">
      <div>
        <h2>工作票管理</h2>
        <p class="page-desc">检修工作票线上流转：状态只能按签发、许可、终结顺序往下走，没许可不许终结，终结后归档；许可与终结挂到对应电站的停运检修记录上。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reconcile">对账：按票重算电站台账</button>
        <button class="btn" type="button" @click="exportRows">导出工作票清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="issue-form" @submit.prevent="submitIssue">
      <label class="form-item">
        <span>票号（同一电站内唯一）</span>
        <input v-model="issueForm.票号" placeholder="如 GZP-2026-0005" />
      </label>
      <label class="form-item">
        <span>所属电站</span>
        <select v-model="issueForm.所属电站">
          <option value="">请选择电站</option>
          <option v-for="item in stationOptions" :key="item.code" :value="item.code">
            {{ item.code }} · {{ item.name }}（{{ item.status }}）
          </option>
        </select>
      </label>
      <label class="form-item">
        <span>工作负责人</span>
        <input v-model="issueForm.工作负责人" placeholder="签发人指定的工作负责人" />
      </label>
      <label class="form-item">
        <span>工作任务</span>
        <input v-model="issueForm.工作任务" placeholder="检修作业内容" />
      </label>
      <label class="form-item span-all">
        <span>安全措施（留白将被整票退回重填）</span>
        <textarea v-model="issueForm.安全措施" rows="2" placeholder="断开的开关、挂接地线、围栏标示等"></textarea>
      </label>
      <div class="form-actions">
        <button class="btn primary" type="submit">签发工作票</button>
        <span class="form-hint">同一张票重复提交两次签发只生效一次</span>
      </div>
    </form>

    <div v-if="closing" class="close-panel">
      <label class="form-item close-panel-field">
        <span>终结登记：{{ closing.票号 }}（许可时间 {{ closing.许可时间 }}）</span>
        <textarea v-model="closeConclusion" rows="2" placeholder="处置结论将落到电站停运检修的待办台账"></textarea>
      </label>
      <button class="btn primary" type="button" @click="confirmClose">确认终结并归档</button>
      <button class="btn ghost" type="button" @click="cancelClose">取消</button>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="permit(row)">办理许可</button>
            <button class="link" type="button" @click="close(row)">办理终结</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无工作票数据，可先在上方签发工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工作票记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
      <span v-else>两处时间不一致时以工作票上的记录为准：票是操作发生时的原始凭证，电站台账是按票重算的派生视图</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import {
  closeTicket,
  issueTicket,
  listStationOptions,
  permitTicket,
  reconcileAllStationLedgers,
  TICKET_KEY,
  TICKET_STATUS,
  type IssueInput,
  type StationOption,
} from '@/api/ticket-service'
import type { EntryRow } from '@/data/types'

const columns = ["票号", "所属电站", "工作负责人", "工作任务", "安全措施", "签发时间", "许可时间", "终结时间", "处置结论", "归档编号"]
const statuses = [TICKET_STATUS.issued, TICKET_STATUS.permitted, TICKET_STATUS.closed]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stationOptions = ref<StationOption[]>([])
const issueForm = reactive<IssueInput>({ 票号: '', 所属电站: '', 工作负责人: '', 工作任务: '', 安全措施: '' })
const closing = ref<EntryRow | null>(null)
const closeConclusion = ref('')

const stats = computed(() => [
  { label: '待许可工作票', value: rows.value.filter((row) => row.status === TICKET_STATUS.issued).length },
  { label: '许可中工作票', value: rows.value.filter((row) => row.status === TICKET_STATUS.permitted).length },
  { label: '已终结归档', value: rows.value.filter((row) => row.status === TICKET_STATUS.closed).length },
])
const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function show(result: { ok: boolean; message: string }) {
  messageOk.value = result.ok
  message.value = result.message
}

function submitIssue() {
  const result = issueTicket(issueForm)
  show(result)
  if (result.ok) {
    issueForm.票号 = ''
    issueForm.工作负责人 = ''
    issueForm.工作任务 = ''
    issueForm.安全措施 = ''
  }
  reload()
}

function permit(row: EntryRow) {
  show(permitTicket(Number(row.id)))
  reload()
}

function close(row: EntryRow) {
  if (String(row.status) !== TICKET_STATUS.permitted) {
    // 没许可或已归档的票直接走服务拿挡回原因，消息里会写清卡在哪一环
    show(closeTicket(Number(row.id), ''))
    reload()
    return
  }
  closing.value = row
  closeConclusion.value = '工作终结，现场已恢复，具备复役条件'
}

function confirmClose() {
  if (!closing.value) {
    return
  }
  const result = closeTicket(Number(closing.value.id), closeConclusion.value)
  show(result)
  if (result.ok) {
    closing.value = null
    closeConclusion.value = ''
  }
  reload()
}

function cancelClose() {
  closing.value = null
  closeConclusion.value = ''
}

function reconcile() {
  reconcileAllStationLedgers()
  show({ ok: true, message: '已按工作票重算各电站的停运检修记录与待办台账，两处口径以票为准' })
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(TICKET_KEY)
}

function reload() {
  reconcileAllStationLedgers()
  stationOptions.value = listStationOptions()
  const payload = listEntries(TICKET_KEY, filters.value)
  rows.value = payload.items
  total.value = payload.total
}

onMounted(reload)
</script>
