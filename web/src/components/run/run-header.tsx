import { useState } from 'react';
import { toast } from 'sonner';
import { Bell, Check, Copy, Download, FolderClosed, Loader2, Menu, OctagonX } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/status-badge';
import { downloadSessionLog, runAction } from '@/lib/api';
import { clock, projectName } from '@/lib/format';
import { copyText } from '@/lib/hooks';
import { runState, stageLabel } from '@/lib/status';
import type { Run } from '@/lib/types';

export function RunHeader({ run, online, onOpenSidebar }: { run: Run; online: boolean; onOpenSidebar?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const copyRef = async () => {
    if (await copyText(run.ref)) { setCopied(true); setTimeout(() => setCopied(false), 1400); }
    else toast.error('Clipboard is not available. Select the ref to copy it.');
  };

  const download = async () => {
    setDownloading(true);
    const id = toast.loading('Preparing session log…');
    try {
      await downloadSessionLog(run.key);
      toast.success('Download started', { id, description: `${run.runId}-session-log.zip — the browser reports any later read failure.` });
    } catch (error) { toast.error('Session log could not be downloaded', { id, description: (error as Error).message }); }
    finally { setDownloading(false); }
  };

  const act = async (name: 'stop' | 'retry-notification') => {
    setBusy(name);
    try { const result = await runAction(run.key, name); toast.success(result.message); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(null); }
  };

  const stage = stageLabel(run.stage);
  return (
    <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b px-4 py-3 lg:px-5">
      {onOpenSidebar && (
        <Button variant="ghost" size="icon" className="-ml-1" onClick={onOpenSidebar} aria-label="Show runs"><Menu /></Button>
      )}
      {/* The actions wrap under the title when both do not fit on one line. */}
      <div className="min-w-0 flex-1 basis-72">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11.5px] whitespace-nowrap text-muted-foreground">
          <FolderClosed className="size-3 shrink-0" aria-hidden />
          <span className="truncate" title={run.project}>{projectName(run.project)}</span>
          <span className="opacity-50">/</span>
          <span className="shrink-0">{run.workerLabel}{stage ? ` ${stage}` : ''}</span>
          {run.model && <span className="hidden min-w-0 items-center gap-1.5 sm:flex"><span className="opacity-50">·</span><span className="truncate font-mono text-[11px]">{run.model}</span></span>}
          <span className="hidden shrink-0 items-center gap-1.5 tabular sm:flex"><span className="opacity-50">·</span>started {clock(run.startedAt)}</span>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="line-clamp-2 min-w-0 text-[17px] leading-tight font-semibold tracking-tight break-words" title={run.task ?? run.title}>{run.task ?? run.title}</h1>
          <StatusBadge state={runState(run)} />
        </div>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="font-mono text-[11px]" onClick={copyRef} aria-label={`Copy run ref ${run.ref}`}>
              {copied ? <Check className="text-success" /> : <Copy />}{run.ref}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy the ref for agent-dispatch commands</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={download} disabled={downloading}>
              {downloading ? <Loader2 className="animate-spin" /> : <Download />}<span className="hidden sm:inline">Session log</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">ZIP with the run files and the full worker session log</TooltipContent>
        </Tooltip>
        {run.canRetryNotification && (
          <Button variant="outline" size="sm" onClick={() => act('retry-notification')} disabled={!online || busy !== null}>
            {busy === 'retry-notification' ? <Loader2 className="animate-spin" /> : <Bell />}Retry notification
          </Button>
        )}
        {run.canStop && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={!online || busy !== null}>
                {busy === 'stop' ? <Loader2 className="animate-spin" /> : <OctagonX />}Stop
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop this run?</AlertDialogTitle>
                <AlertDialogDescription>
                  The worker and its child processes stop. The run folder, its files and the worker session are kept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep running</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => act('stop')}>Stop run</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </header>
  );
}
