'use strict';

const roofline = require('../mobile-ap-roofline.js');

const report = roofline.calibrationReport();
console.log(JSON.stringify({
  schema: report.schema,
  hardware: roofline.MOBILE_AP_HARDWARE,
  measurements: roofline.MOBILE_AP_MEASUREMENTS.map(row => ({
    ...row,
    decomposition: roofline.decomposeMeasurement(row)
  })),
  measuredDenseGpuCpu: report.denseGpuCpu
}, null, 2));
