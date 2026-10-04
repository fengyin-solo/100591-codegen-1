import { createRouter, createWebHistory } from 'vue-router'

import Dashboard from '@/views/Dashboard.vue'
const Station = () => import('@/views/station/index.vue')
const Array = () => import('@/views/array/index.vue')
const Inverter = () => import('@/views/inverter/index.vue')
const Combiner = () => import('@/views/combiner/index.vue')
const Tracker = () => import('@/views/tracker/index.vue')
const Cleaning = () => import('@/views/cleaning/index.vue')
const Alarm = () => import('@/views/alarm/index.vue')
const Defect = () => import('@/views/defect/index.vue')
const Ticket = () => import('@/views/ticket/index.vue')
const Patrol = () => import('@/views/patrol/index.vue')
const Spare = () => import('@/views/spare/index.vue')
const Meter = () => import('@/views/meter/index.vue')
const Dispatch = () => import('@/views/dispatch/index.vue')
const Irradiance = () => import('@/views/irradiance/index.vue')
const Tooling = () => import('@/views/tooling/index.vue')
const Fire = () => import('@/views/fire/index.vue')
const Settlement = () => import('@/views/settlement/index.vue')
const Contract = () => import('@/views/contract/index.vue')
const Crew = () => import('@/views/crew/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: Dashboard },
    { path: '/station', name: 'station', component: Station },
    { path: '/array', name: 'array', component: Array },
    { path: '/inverter', name: 'inverter', component: Inverter },
    { path: '/combiner', name: 'combiner', component: Combiner },
    { path: '/tracker', name: 'tracker', component: Tracker },
    { path: '/cleaning', name: 'cleaning', component: Cleaning },
    { path: '/alarm', name: 'alarm', component: Alarm },
    { path: '/defect', name: 'defect', component: Defect },
    { path: '/ticket', name: 'ticket', component: Ticket },
    { path: '/patrol', name: 'patrol', component: Patrol },
    { path: '/spare', name: 'spare', component: Spare },
    { path: '/meter', name: 'meter', component: Meter },
    { path: '/dispatch', name: 'dispatch', component: Dispatch },
    { path: '/irradiance', name: 'irradiance', component: Irradiance },
    { path: '/tooling', name: 'tooling', component: Tooling },
    { path: '/fire', name: 'fire', component: Fire },
    { path: '/settlement', name: 'settlement', component: Settlement },
    { path: '/contract', name: 'contract', component: Contract },
    { path: '/crew', name: 'crew', component: Crew },
  ],
})

export default router
