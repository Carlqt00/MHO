import { REPORT_STATUS_LABEL, type AppointmentReportRow, type ReportData, type ReportCount } from './reports'

const LOGO_PATH = '/daraga-municipality-seal.svg'

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

function generatedLabel(d: Date): string {
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function periodLabel(data: ReportData): string {
  return `${data.filters.range.label} (${data.filters.range.from} to ${data.filters.range.to})`
}

function filePrefix(data: ReportData): string {
  const type = data.filters.reportType.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const status = data.filters.status === 'all' ? 'all-statuses' : data.filters.status.replace('_', '-')
  return `mho-report-${type}-${status}-${data.filters.range.fileLabel}`
}

function volumeLabel(period: string, mode: ReportData['volumeMode']): string {
  const [year, month, day] = period.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString('en-PH', {
    timeZone: 'UTC',
    month: 'short',
    day: mode === 'day' ? 'numeric' : undefined,
    year: mode === 'month' ? 'numeric' : undefined,
  })
}

function rowDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function rowTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function loadWatermarkDataUrl(): Promise<string | null> {
  try {
    const response = await fetch(LOGO_PATH)
    if (!response.ok) return null
    const svg = await response.text()
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.decoding = 'async'
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Report seal could not be loaded.'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = 720
      canvas.height = 720
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(img, 40, 40, 640, 640)
      // Preserve the seal's detail by fading pale fills more than dark ink.
      // Bake mint color and low opacity into the PNG for both export formats.
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < image.data.length; i += 4) {
        const luminance = (0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]) / 255
        image.data[i + 3] = Math.round(image.data[i + 3] * (1 - luminance) * 0.08)
        image.data[i] = 5
        image.data[i + 1] = 150
        image.data[i + 2] = 105
      }
      ctx.putImageData(image, 0, 0)
      return canvas.toDataURL('image/png')
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch {
    return null
  }
}

export async function exportReportPdf(data: ReportData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const watermark = await loadWatermarkDataUrl()
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 40
  const green = '#047857'
  const text = '#0f172a'
  const muted = '#64748b'
  const border = '#d1fae5'
  let y = 42

  const drawWatermark = () => {
    if (!watermark) return
    const size = Math.min(pageWidth * 0.8, pageHeight * 0.6)
    doc.addImage(watermark, 'PNG', (pageWidth - size) / 2, (pageHeight - size) / 2, size, size)
  }
  // Paint first on the initial page and every added page, behind all text,
  // tables, charts and footers. The PNG itself already has low opacity.
  drawWatermark()
  doc.internal.events.subscribe('addPage', drawWatermark)

  const addFooter = () => {
    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i += 1) {
      doc.setPage(i)
      doc.setDrawColor(border)
      doc.line(margin, pageHeight - 34, pageWidth - margin, pageHeight - 34)
      doc.setTextColor(muted)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.text('MHO Daraga - Appointment and Ticketing System', margin, pageHeight - 18)
      doc.text(`Page ${i} of ${pages}`, pageWidth - margin, pageHeight - 18, { align: 'right' })
    }
  }

  const ensureSpace = (height: number) => {
    if (y + height <= pageHeight - 48) return
    doc.addPage()
    y = 42
  }

  const sectionTitle = (title: string) => {
    ensureSpace(30)
    doc.setTextColor(green)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.text(title.toUpperCase(), margin, y)
    doc.setDrawColor(border)
    doc.line(margin, y + 8, pageWidth - margin, y + 8)
    y += 24
  }

  const keyValue = (label: string, value: string, x: number, top: number) => {
    doc.setTextColor(muted)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text(label.toUpperCase(), x, top)
    doc.setTextColor(text)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.text(value, x, top + 14)
  }

  doc.setTextColor(text)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.text('MHO Daraga', margin, y + 8)
  doc.setFontSize(10)
  doc.setFont('helvetica', 'normal')
  doc.text('Municipal Health Office', margin, y + 24)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.text('Appointment Report', margin, y + 46)
  y += 78

  const metaTop = y
  keyValue('Report Type', data.filters.reportType, margin, metaTop)
  keyValue('Status Filter', REPORT_STATUS_LABEL[data.filters.status], margin + 190, metaTop)
  keyValue('Period', periodLabel(data), margin, metaTop + 42)
  keyValue('Generated', generatedLabel(data.generatedAt), margin + 300, metaTop + 42)
  y += 94

  sectionTitle('Summary Metrics')
  const metrics = [
    ['Total', data.summary.total],
    ['Booked', data.summary.booked],
    ['Checked In', data.summary.checked_in],
    ['Served', data.summary.served],
    ['Cancelled', data.summary.cancelled],
    ['No-show', data.summary.no_show],
  ] as const
  const metricWidth = (pageWidth - margin * 2) / 3
  metrics.forEach(([label, value], index) => {
    const col = index % 3
    const row = Math.floor(index / 3)
    const x = margin + col * metricWidth
    const top = y + row * 38
    doc.setTextColor(muted)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text(label.toUpperCase(), x, top)
    doc.setTextColor(text)
    doc.setFontSize(18)
    doc.text(String(value), x, top + 20)
  })
  y += 92

  sectionTitle('Patient Statistics')
  const patientMetrics = [
    ['Total Registered Patients', data.patients.total],
    ['New Registrations', data.patients.newInRange],
    ['Unique Patients With Appointment', data.patients.uniqueWithAppointment],
    ['Unique Patients Served', data.patients.uniqueServed],
  ] as const
  patientMetrics.forEach(([label, value], index) => {
    const x = margin + (index % 2) * 260
    const top = y + Math.floor(index / 2) * 34
    keyValue(label, String(value), x, top)
  })
  y += 82

  sectionTitle('Rates')
  keyValue('No-show Rate', pct(data.rates.noShowRate), margin, y)
  keyValue('Cancellation Rate', pct(data.rates.cancelledRate), margin + 180, y)
  keyValue('Completion Rate', pct(data.rates.completionRate), margin + 360, y)
  y += 48

  sectionTitle('Appointment Trend')
  const chartX = margin
  const chartY = y
  const chartWidth = pageWidth - margin * 2
  const chartHeight = 130
  const maxVolume = Math.max(1, ...data.volume.map((row) => row.total))
  doc.setDrawColor(border)
  doc.rect(chartX, chartY, chartWidth, chartHeight)
  if (data.volume.every((row) => row.total === 0)) {
    doc.setTextColor(muted)
    doc.setFontSize(10)
    doc.text('No appointments in this period.', pageWidth / 2, chartY + 70, { align: 'center' })
  } else {
    const barGap = 4
    const barWidth = Math.max(5, Math.min(24, (chartWidth - 40 - barGap * data.volume.length) / data.volume.length))
    data.volume.forEach((row, index) => {
      const x = chartX + 20 + index * ((chartWidth - 40 - barWidth) / Math.max(1, data.volume.length - 1))
      const h = (row.total / maxVolume) * 86
      doc.setFillColor(green)
      doc.roundedRect(x, chartY + 96 - h, barWidth, h, 2, 2, 'F')
      if (data.volume.length <= 12 || index === 0 || index === data.volume.length - 1 || index % 5 === 0) {
        doc.setTextColor(muted)
        doc.setFontSize(7)
        doc.text(volumeLabel(row.period, data.volumeMode), x + barWidth / 2, chartY + 114, { align: 'center' })
      }
    })
  }
  y += chartHeight + 30

  if (data.filters.reportType === 'General Report') {
    sectionTitle('Service Distribution')
    y = drawCountRows(doc, data.byService, y, margin, pageWidth, pageHeight, ensureSpace)
  }

  sectionTitle(data.filters.reportType === 'General Report' ? 'By Provider' : 'Provider Breakdown')
  y = drawCountRows(doc, data.byProvider, y, margin, pageWidth, pageHeight, ensureSpace)

  sectionTitle('Detailed Appointment Records')
  y = drawAppointmentRows(doc, data.rows, y, margin, pageWidth, pageHeight, ensureSpace)

  addFooter()
  doc.save(`${filePrefix(data)}.pdf`)
}

function drawCountRows(
  doc: import('jspdf').jsPDF,
  rows: ReportCount[],
  startY: number,
  margin: number,
  pageWidth: number,
  _pageHeight: number,
  ensureSpace: (height: number) => void
) {
  let y = startY
  const drawHeader = () => {
    ensureSpace(26)
    doc.setFillColor('#ecfdf5')
    doc.rect(margin, y - 12, pageWidth - margin * 2, 22, 'F')
    doc.setTextColor('#0f172a')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text('Name', margin + 6, y + 2)
    doc.text('Total', pageWidth - margin - 150, y + 2)
    doc.text('Served', pageWidth - margin - 100, y + 2)
    doc.text('No-show', pageWidth - margin - 45, y + 2)
    y += 24
  }
  drawHeader()
  if (rows.length === 0) {
    doc.setTextColor('#64748b')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text('No records found.', margin + 6, y)
    return y + 24
  }
  rows.forEach((row) => {
    ensureSpace(22)
    doc.setTextColor('#0f172a')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.text(row.name, margin + 6, y, { maxWidth: pageWidth - margin * 2 - 190 })
    doc.text(String(row.count), pageWidth - margin - 150, y)
    doc.text(String(row.served), pageWidth - margin - 100, y)
    doc.text(String(row.no_show), pageWidth - margin - 45, y)
    y += 18
  })
  return y + 12
}

function drawAppointmentRows(
  doc: import('jspdf').jsPDF,
  rows: AppointmentReportRow[],
  startY: number,
  margin: number,
  pageWidth: number,
  _pageHeight: number,
  ensureSpace: (height: number) => void
) {
  let y = startY
  const drawHeader = () => {
    ensureSpace(26)
    doc.setFillColor('#ecfdf5')
    doc.rect(margin, y - 12, pageWidth - margin * 2, 22, 'F')
    doc.setTextColor('#0f172a')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.text('Date', margin + 4, y + 2)
    doc.text('Time', margin + 66, y + 2)
    doc.text('Patient', margin + 110, y + 2)
    doc.text('Service', margin + 230, y + 2)
    doc.text('Provider', margin + 320, y + 2)
    doc.text('Ticket', margin + 430, y + 2)
    doc.text('Status', pageWidth - margin - 52, y + 2)
    y += 24
  }
  drawHeader()
  if (rows.length === 0) {
    doc.setTextColor('#64748b')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.text('No appointment records found for the selected filters.', margin + 6, y)
    return y + 24
  }
  rows.forEach((row) => {
    ensureSpace(24)
    doc.setTextColor('#0f172a')
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.text(rowDate(row.appointmentAt), margin + 4, y)
    doc.text(rowTime(row.appointmentAt), margin + 66, y)
    doc.text(row.patient, margin + 110, y, { maxWidth: 108 })
    doc.text(row.service, margin + 230, y, { maxWidth: 80 })
    doc.text(row.provider, margin + 320, y, { maxWidth: 100 })
    doc.text(row.ticketNumber || '-', margin + 430, y, { maxWidth: 56 })
    doc.text(REPORT_STATUS_LABEL[row.status], pageWidth - margin - 52, y)
    y += 18
  })
  return y + 12
}

export async function exportReportExcel(data: ReportData): Promise<void> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'MHO Daraga Appointment and Ticketing System'
  wb.created = data.generatedAt
  wb.modified = new Date()
  const s = data.summary

  const fill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFEFF6F1' } }
  const darkFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF047857' } }
  const border = { style: 'thin' as const, color: { argb: 'FFD1FAE5' } }
  const sectionFont = { bold: true, color: { argb: 'FF065F46' } }

  const styleHeaderRow = (worksheet: import('exceljs').Worksheet, rowNumber: number) => {
    const row = worksheet.getRow(rowNumber)
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    row.fill = darkFill
    row.alignment = { vertical: 'middle' }
    row.eachCell((cell) => {
      cell.border = { top: border, left: border, bottom: border, right: border }
    })
  }

  const styleSectionRow = (worksheet: import('exceljs').Worksheet, rowNumber: number, fromCol = 1, toCol = 2) => {
    for (let column = fromCol; column <= toCol; column += 1) {
      const cell = worksheet.getCell(rowNumber, column)
      cell.font = sectionFont
      cell.fill = fill
      cell.border = { top: border, left: border, bottom: border, right: border }
    }
  }

  const appendTableSheet = (name: string, rows: (string | number | null)[][], widths: number[]) => {
    const worksheet = wb.addWorksheet(name, {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    worksheet.columns = widths.map((width) => ({ width }))
    worksheet.addRows(rows)
    styleHeaderRow(worksheet, 1)
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true }
        if (rowNumber > 1) {
          cell.border = { bottom: { style: 'hair' as const, color: { argb: 'FFE5E7EB' } } }
        }
      })
    })
    return worksheet
  }

  const summary = wb.addWorksheet('Report Summary', {
    views: [{ state: 'frozen', ySplit: 9 }],
  })
  summary.columns = [{ width: 24 }, { width: 18 }, { width: 24 }, { width: 36 }]
  summary.mergeCells('A1:D1')
  summary.mergeCells('A2:D2')
  summary.mergeCells('A3:D3')
  summary.getRow(1).height = 28
  summary.getRow(2).height = 20
  summary.getRow(3).height = 24
  summary.getRow(4).height = 12
  summary.getCell('A1').value = 'MHO Daraga'
  summary.getCell('A1').font = { bold: true, size: 18, color: { argb: 'FF0F172A' } }
  summary.getCell('A2').value = 'Municipal Health Office'
  summary.getCell('A2').font = { size: 11, color: { argb: 'FF475569' } }
  summary.getCell('A3').value = 'Appointment Report'
  summary.getCell('A3').font = { bold: true, size: 14, color: { argb: 'FF047857' } }

  summary.addRows([
    [],
    ['Report Type', data.filters.reportType, 'Status Filter', REPORT_STATUS_LABEL[data.filters.status]],
    ['Period', periodLabel(data), 'Generated Date/Time', generatedLabel(data.generatedAt)],
    [],
    ['Summary', 'Value'],
    ['Total Appointments', s.total],
    ['Booked', s.booked],
    ['Checked In', s.checked_in],
    ['Served', s.served],
    ['Cancelled', s.cancelled],
    ['No-show', s.no_show],
    [],
    ['Patient Statistics', 'Value'],
    ['Total Registered Patients', data.patients.total],
    ['New Registrations', data.patients.newInRange],
    ['Unique Patients With Appointment', data.patients.uniqueWithAppointment],
    ['Unique Patients Served', data.patients.uniqueServed],
    [],
    ['Rates', 'Value'],
    ['No-show Rate', data.rates.noShowRate],
    ['Cancellation Rate', data.rates.cancelledRate],
    ['Completion Rate', data.rates.completionRate],
  ])
  ;[6, 9, 17, 23].forEach((rowNumber) => styleSectionRow(summary, rowNumber, 1, rowNumber === 6 ? 4 : 2))
  ;[24, 25, 26].forEach((rowNumber) => {
    summary.getCell(rowNumber, 2).numFmt = '0.0%'
  })
  summary.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true }
      cell.border = { bottom: { style: 'hair' as const, color: { argb: 'FFE5E7EB' } } }
    })
  })

  appendTableSheet(
    'Detailed Appointments',
    [
      ['Date', 'Time', 'Patient', 'Service', 'Provider', 'Ticket Number', 'Queue Number', 'Status', 'Appointment ID'],
      ...data.rows.map((row) => [
        rowDate(row.appointmentAt),
        rowTime(row.appointmentAt),
        row.patient,
        row.service,
        row.provider,
        row.ticketNumber || '',
        row.queueNumber,
        REPORT_STATUS_LABEL[row.status],
        row.id,
      ]),
    ],
    [16, 14, 28, 22, 28, 18, 14, 16, 38]
  )

  appendTableSheet(
    'By Service',
    [
      ['Service', 'Appointments', 'Served', 'Cancelled', 'No-show'],
      ...data.byService.map((row) => [row.name, row.count, row.served, row.cancelled, row.no_show]),
    ],
    [28, 16, 14, 14, 14]
  )

  appendTableSheet(
    'By Provider',
    [
      ['Provider', 'Appointments', 'Served', 'Cancelled', 'No-show'],
      ...data.byProvider.map((row) => [row.name, row.count, row.served, row.cancelled, row.no_show]),
    ],
    [34, 16, 14, 14, 14]
  )

  appendTableSheet(
    'Appointment Trend',
    [
      ['Period', 'Appointment Count'],
      ...data.volume.map((row) => [volumeLabel(row.period, data.volumeMode), row.total]),
    ],
    [22, 22]
  )

  const watermark = await loadWatermarkDataUrl()
  if (watermark) {
    const imageId = wb.addImage({ base64: watermark, extension: 'png' })
    wb.eachSheet((worksheet) => {
      // Excel backgrounds tile. Use one square PNG with opacity baked in,
      // centered over the used columns and report height instead.
      const widths = worksheet.columns.map((column) => Math.floor((column.width ?? 8.43) * 7 + 5))
      const heights = Array.from({ length: worksheet.rowCount }, (_, i) =>
        (worksheet.getRow(i + 1).height ?? worksheet.properties.defaultRowHeight) * 96 / 72
      )
      const width = widths.reduce((total, value) => total + value, 0)
      const height = Math.max(400, heights.reduce((total, value) => total + value, 0))
      const size = Math.min(520, width * 0.8, height * 0.8)
      let left = (width - size) / 2
      let top = (height - size) / 2
      let col = 0
      let row = 0
      while (col < widths.length - 1 && left >= widths[col]) {
        left -= widths[col]
        col += 1
      }
      const defaultHeight = worksheet.properties.defaultRowHeight * 96 / 72
      while (top >= (heights[row] ?? defaultHeight)) {
        top -= heights[row] ?? defaultHeight
        row += 1
      }
      // Native offsets use EMUs (9,525 per pixel), avoiding ExcelJS's
      // fractional-column conversion for custom column widths.
      const tl = {
        col, row, nativeCol: col, nativeRow: row,
        nativeColOff: Math.round(left * 9525),
        nativeRowOff: Math.round(top * 9525),
      }
      worksheet.addImage(imageId, {
        tl,
        ext: { width: size, height: size },
        editAs: 'absolute',
      })
    })
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${filePrefix(data)}.xlsx`
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
