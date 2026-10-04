<script setup lang="ts">
import { ref } from "vue";
import { ElTabs, ElTabPane } from "element-plus";
import NetworkHeader from "./components/NetworkHeader.vue";
import PlanPanel from "./components/PlanPanel.vue";
import BatchesPanel from "./components/BatchesPanel.vue";
import ConflictPanel from "./components/ConflictPanel.vue";
import ReceiptLedger from "./components/ReceiptLedger.vue";
import SyncLogPanel from "./components/SyncLogPanel.vue";

const activeTab = ref("batches");
</script>

<template>
  <main class="app">
    <div class="shell">
      <NetworkHeader />

      <ElTabs v-model="activeTab" class="main-tabs">
        <ElTabPane label="离线批次与同步" name="batches">
          <BatchesPanel />
        </ElTabPane>
        <ElTabPane label="配送计划（版本）" name="plan">
          <PlanPanel />
        </ElTabPane>
        <ElTabPane label="冲突台账" name="conflicts">
          <ConflictPanel />
        </ElTabPane>
        <ElTabPane label="回执幂等台账" name="receipts">
          <ReceiptLedger />
        </ElTabPane>
        <ElTabPane label="同步日志" name="logs">
          <SyncLogPanel />
        </ElTabPane>
      </ElTabs>

      <footer class="foot-note">
        数据仅保存在浏览器 localStorage；点击右上「重置演示数据」可恢复夜间断网初始场景。
      </footer>
    </div>
  </main>
</template>
