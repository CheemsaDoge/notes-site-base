export default {
  worker: {
    name: "course-demo-notes",
    entrypoint: "./src/worker.mjs",
    compatibilityDate: "2026-11-15",
    workersDev: true,
    observability: {
      enabled: true,
      traces: {
        enabled: true,
      },
    },
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "404-page",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      DB: {
        type: "d1",
        name: "course-demo-sync",
        id: "YOUR_D1_DATABASE_ID",
      },
      ASSETS: {
        type: "assets",
      },
    },
  },
};
