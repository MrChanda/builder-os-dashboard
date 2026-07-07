/**
 * BUILDER OS — points_delta.gs (Stage 1)
 * Returns the TRUE awarded row from GOAL_COMPLETIONS for a task, so
 * reward toasts show what the ledger actually granted (incl. late
 * penalties + secondary stat), not the task's face value.
 *
 * WIRING (handleUpdateTask): after the completion is logged, add:
 *   if (String(newStatus).toUpperCase() === 'COMPLETE')
 *     result.awarded = getAwardedDelta_(taskId);
 */

function getAwardedDelta_(taskId) {
  var sh = SpreadsheetApp.getActive().getSheetByName('GOAL_COMPLETIONS');
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  // Header layout (row 2): LOG_ID DATE COMPLETION_TIMESTAMP DOMAIN TASK_ID
  //   TASK_NAME COMPLETION_TYPE STAT_AWARDED STAT_SECONDARY ON_TIME
  //   POINTS_AWARDED POINTS_SECONDARY STREAK_ELIGIBLE NOTES
  var COL = { LOG_ID:0, TASK_ID:4, STAT_AWARDED:7, STAT_SECONDARY:8,
              ON_TIME:9, POINTS_AWARDED:10, POINTS_SECONDARY:11 };
  for (var r = data.length - 1; r >= 2; r--) {          // newest first
    if (String(data[r][COL.TASK_ID]) === String(taskId)) {
      return {
        log_id:            data[r][COL.LOG_ID],
        stat_awarded:      data[r][COL.STAT_AWARDED],
        stat_secondary:    data[r][COL.STAT_SECONDARY],
        on_time:           data[r][COL.ON_TIME],
        points_awarded:    Number(data[r][COL.POINTS_AWARDED]) || 0,
        points_secondary:  Number(data[r][COL.POINTS_SECONDARY]) || 0
      };
    }
  }
  return null;
}

function testGetAwardedDelta() { Logger.log(JSON.stringify(getAwardedDelta_('HG3'))); }