/**
 * 休息提醒流程
 */

import SpeechBubble from '../components/SpeechBubble'
import { snoozeBreak, notifyBreakDone } from '../hooks/useIPC'
import { getConfig } from '../hooks/useIPC'
import { useEffect, useState } from 'react'

interface Props {
  elapsedMin: number
  onDone: () => void
}

export default function BreakReminder({ elapsedMin, onDone }: Props) {
  const [snoozeMins, setSnoozeMins] = useState(10)

  useEffect(() => {
    getConfig().then(cfg => setSnoozeMins(cfg.snooze_min))
  }, [])

  const handleRest = () => {
    notifyBreakDone()
    onDone()
  }

  const handleSnooze = () => {
    snoozeBreak(snoozeMins)
    onDone()
  }

  return (
    <SpeechBubble
      visible
      message={`喵～你已经连续工作 ${elapsedMin} 分钟了！\n起来活动一下，喝杯水吧 🐾`}
    >
      <div className="bubble-actions">
        <button className="btn-secondary" onClick={handleSnooze}>
          再等 {snoozeMins} 分钟
        </button>
        <button className="btn-primary" onClick={handleRest}>
          好的，去休息
        </button>
      </div>
    </SpeechBubble>
  )
}
