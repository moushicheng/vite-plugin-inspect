<script setup lang="ts">
import { toggleDark } from '../logic'
import { usePayloadStore } from '../stores/payload'

const payload = usePayloadStore()
</script>

<template>
  <nav h-54px flex="~ none gap-2" border="b main" pl-4 pr-4 font-light children:my-auto>
    <slot />
    <slot name="actions">
      <template v-if="!payload.metadata.embedded">
        <div mx1 h-full w-0 border="r main" />
        <a
          icon-btn text-lg
          href="https://github.com/antfu/vite-plugin-inspect"
          target="_blank"
        >
          <div i-carbon-logo-github />
        </a>
        <button class="icon-btn text-lg" title="Toggle Dark Mode" @click="toggleDark()">
          <span i-carbon-sun dark:i-carbon-moon />
        </button>
      </template>
    </slot>
  </nav>
</template>
