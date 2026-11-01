from fastapi.responses import JSONResponse

from ..schemas import TaskRef


async def wait_or_202(c, task, wait, transform=None):
    """?wait=N façade (03 §2.7): result within N s -> 200, else 202 TaskRef."""
    res = await c.tasks.wait(task, wait)
    if res is None:
        return JSONResponse(TaskRef(task_id=task.id, kind=task.kind, state=task.state).model_dump(),
                            status_code=202)
    return transform(res) if transform else res


def attachment(name):
    from urllib.parse import quote
    safe = ''.join(ch if ch.isascii() and (ch.isalnum() or ch in '._-') else '_' for ch in name) or 'download'
    return "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (safe, quote(name))
