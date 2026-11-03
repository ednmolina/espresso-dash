"""Ground-truth renderer (4x supersampled ellipses with known area-equivalent size).

Adapted from the science architect harness. No repo imports (see tests/core/conftest.py).
"""
import numpy as np

def gblur(a, s):
    r=int(3*s)+1; k=np.exp(-0.5*(np.arange(-r,r+1)/s)**2); k/=k.sum()
    a=np.apply_along_axis(lambda v: np.convolve(np.pad(v,r,mode='edge'),k,'valid'),0,a)
    return np.apply_along_axis(lambda v: np.convolve(np.pad(v,r,mode='edge'),k,'valid'),1,a)

def render(W, H, parts, ss=4, blur=0.0, vignette=0.0, noise=3.0, seed=0, bgval=235., pcol=(95,60,40), gradient=0.0):
    """parts: list of (cx,cy,a,b,theta) in px (semi-axes). Returns rgb uint8, idmap."""
    rng = np.random.default_rng(seed)
    cov = np.zeros((H, W)); idmap = np.zeros((H, W), np.int32)
    for k,(cx,cy,a,b,th) in enumerate(parts):
        R = int(a)+3
        x0,x1 = max(0,int(cx)-R), min(W,int(cx)+R+1); y0,y1 = max(0,int(cy)-R), min(H,int(cy)+R+1)
        if x1<=x0 or y1<=y0: continue
        # supersampled coverage
        ys = (np.arange(y0*ss, y1*ss)+0.5)/ss - 0.5; xs = (np.arange(x0*ss, x1*ss)+0.5)/ss - 0.5
        X, Y = np.meshgrid(xs-cx, ys-cy)
        u = X*np.cos(th)+Y*np.sin(th); v = -X*np.sin(th)+Y*np.cos(th)
        inside = ((u/a)**2+(v/b)**2) <= 1
        c = inside.reshape(y1-y0, ss, x1-x0, ss).mean(axis=(1,3))
        sub = cov[y0:y1,x0:x1]
        idsub = idmap[y0:y1,x0:x1]; idsub[c>0.5] = k+1
        cov[y0:y1,x0:x1] = np.maximum(sub, c)
    if blur>0: cov = gblur(cov, blur)
    yy, xx = np.mgrid[0:H,0:W]
    r2 = ((xx-W/2)/(W/2))**2 + ((yy-H/2)/(H/2))**2
    bg = bgval*(1 - vignette*r2/2) * (1 + gradient*(xx/W-0.5))
    img = np.empty((H,W,3))
    for ch,(f,pc) in enumerate(zip((0.98,0.97,1.0), pcol)):
        img[...,ch] = bg*f*(1-cov) + pc*cov*(bg/bgval)
    img += rng.normal(0, noise, img.shape)
    return np.clip(img,0,255).astype(np.uint8), idmap

def place(W, H, diam_px_list, ecc=(0.6,1.0), gap=2, seed=0, margin=0, touching_frac=0.0):
    rng = np.random.default_rng(seed)
    parts=[]; occ=[]
    for d in sorted(diam_px_list, reverse=True):
        e = rng.uniform(*ecc); r=d/2
        a = r/np.sqrt(e); b = r*np.sqrt(e)   # area-equivalent radius r
        th = rng.uniform(0,np.pi)
        for _ in range(200):
            cx,cy = rng.uniform(margin, W-margin), rng.uniform(margin, H-margin)
            if all((cx-x)**2+(cy-y)**2 > (a+ra+gap)**2 for x,y,ra in occ):
                parts.append((cx,cy,a,b,th)); occ.append((cx,cy,a)); break
    return parts

def match(res, idmap, nparts):
    out = {}
    for c in res.dataset.clusters:
        ids = idmap[c.x_pixels, c.y_pixels]; ids = ids[ids>0]
        if ids.size==0: out.setdefault(-1,[]).append(c); continue
        k = np.bincount(ids).argmax()-1
        out.setdefault(k,[]).append(c)
    return out

def moments(c):
    x = c.x_pixels.astype(float); y = c.y_pixels.astype(float)
    cv = np.cov(np.vstack([x,y]), bias=True) + np.eye(2)/12.0
    l = np.sort(np.linalg.eigvalsh(cv))[::-1]
    return 2*np.sqrt(l[0]), 2*np.sqrt(l[1])
