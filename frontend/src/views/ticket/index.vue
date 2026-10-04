<template>
  <section class="page" data-module="ticket">
    <header class="page-head">
      <div>
        <h2>工作票管理</h2>
        <p class="page-desc">维护检修工作票，围绕票号、所属电站、工作内容、安全措施做登记，状态只能顺着签发、许可、终结、归档按序流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">签发工作票</button>
        <button class="btn" type="button" @click="exportRows">导出工作票清单</button>
      </div>
    </header>

    <form v-if="showCreate" class="filter-bar create-bar" @submit.prevent="submitIssue">
      <label class="filter-item">
        <span>票号</span>
        <input v-model="draft.票号" placeholder="同一电站内唯一" />
      </label>
      <label class="filter-item">
        <span>所属电站</span>
        <select v-model="draft.所属电站">
          <option value="" disabled>选择电站</option>
          <option v-for="station in stations" :key="String(station.id)" :value="String(station.电站编号)">
            {{ station.电站编号 }} · {{ station.电站名称 }}（{{ station.status }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>工作内容</span>
        <input v-model="draft.工作内容" placeholder="检修内容" />
      </label>
      <label class="filter-item">
        <span>工作负责人</span>
        <input v-model="draft.工作负责人" />
      </label>
      <label class="filter-item">
        <span>签发人</span>
        <input v-model="draft.签发人" />
      </label>
      <label class="filter-item">
        <span>许可人</span>
        <input v-model="draft.许可人" />
      </label>
      <label class="filter-item">
        <span>安全措施</span>
        <input v-model="draft.安全措施" placeholder="留空整票退回重填" />
      </label>
      <label class="filter-item">
        <span>计划开工</span>
        <input v-model="draft.计划开工" type="date" />
      </label>
      <button class="btn primary" type="submit">提交签发</button>
      <button class="btn ghost" type="button" @click="showCreate = false">收起</button>
    </form>

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
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无工作票数据，可先签发工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条工作票记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  issueTicket,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, TicketDraft } from '@/data/types'

const meta = moduleMeta('ticket')
const columns = ["票号", "所属电站", "工作内容", "工作负责人", "签发人", "许可人", "安全措施", "计划开工", "许可时间", "终结时间", "终结结论", "票面状态"]
const actions = ["许可开工", "办理终结", "归档"]
const statuses = ["已签发", "已许可", "已终结", "已归档"]
const stats = [{"label": "待许可票", "value": 0}, {"label": "许可作业中票", "value": 0}, {"label": "已终结票", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const showCreate = ref(false)
const stations = ref<EntryRow[]>([])
const emptyDraft = (): TicketDraft => ({
  票号: '',
  所属电站: '',
  工作内容: '',
  工作负责人: '',
  签发人: '',
  许可人: '',
  安全措施: '',
  计划开工: '',
})
const draft = ref<TicketDraft>(emptyDraft())

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitIssue() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = issueTicket(draft.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  draft.value = emptyDraft()
  showCreate.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  let extra: Record<string, string> | undefined
  if (action === '办理终结') {
    const conclusion = window.prompt(`填写工作票${row.票号}的终结结论（将同步到电站停运检修待办台账）`)
    if (conclusion === null) {
      return
    }
    extra = { 终结结论: conclusion }
  }
  const result = applyAction(meta.key, Number(row.id), action, extra)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stations.value = listEntries('station').items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '工作票列表读取失败'
  }
}

onMounted(reload)
</script>
