from fastapi import APIRouter
from app.api import deps

router = APIRouter()


@router.get("/account")
def account():
    pos = deps.broker.positions()
    acc = deps.broker.account()
    return {**acc, "open_positions": len(pos), "positions": pos}
