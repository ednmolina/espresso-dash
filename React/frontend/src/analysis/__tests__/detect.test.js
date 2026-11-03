// Tests for detect.js. Expected values marked REF come from the Python implementation
// (cloudrun/coffeegrindsize_core.analysis) run with the venv Python (generator scripts
// gen_detect.py in the P1 builder scratchpad); they pin exact (===) parity for the
// global-background / fixed-threshold paths. poly4/half_contrast parity is covered by
// the P4 fixtures (parity.*.test.js).
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS, makeSettings, legacySettings, analyzeImageBlue, detectParticles, remeasureClusters,
  buildPolygonMask, polygonEdgeGrid, medianU8, backgroundMedian, clustersWithinRadius,
  thresholdIndexLayer, clusterIndexLayer, setClosePolygonEdges,
} from '../detect.js'
import { makeDataset } from '../dataset.js'

const REF = {"h": 72, "w": 88, "blue": "0tbOysvKyMnP1tfX2c/R1NLT19PV0dTb1tna1trZyK+Xg3BeRzs8QDtBTmV/k6S7ztva19rY2NnX2trZ29fT1tjX2dnW07ywnpOSnbC/y9TV1tTR1NHL0M7Nyb/Av7q6wsbJydXU09XT2NfV2NfT19bT1trX28esmoltV0Q4OD07RVprgpaqv9fZ2tzc1tbY2dzW19nc3NXX1drZ1sSwnYR5fIqfsMfO1dfO0tbSzdbCxLm1tLO0tba+wcbN1NbZ2Nfa19na1dfd1tzW2tG+qpWFcV5JQT89O1Jld42is8rb29nY2t7g2NbY19jSwL2+yNbb39S/ppB6dXuGm7LFztXV1dHS2dXVvLi0rqeopKesrbO+wczS1NfW0tTX3dfY29rY3t3Nw62bhXRmVkpDR1FadoKWqb/L29bX1dXc2NnZ1tfCr5eTmKO1ytXYv6iNf3p8jKO4z9jW1dbS0dXS1a6wpqaWlp6cn6OosbS/ztXW2NvY2Nrb3dna3NTa1sGrnY14Z1tYVVZcaXyNorHH3Nbh3NzX193d093OsJB8bHGFmrfQ1cayoZKPk5yzx9XV0NbZ1dbW0tSpqJ2TjZOQkI6VmaervMLK29LW19zc2tTY1t7Z3N3EtJ+QgXNpY2llcHqEn6+80dbc4N/X1tzg297WwKF/YFlVZoupxtG8q56Zm6m6ztfS3NDb09nU1tTTgGF0iYSBgYaDiI6YpKq3wc/S2tzX2dfd3OPZ2NnXyrmqmYaAdnNtcnmEjam70N7g3dzZ3ODW2dzg2L6fiFxXWWiLq765q5qRkp+yyNnf1dTX1tjZ1tTW1mhLYn13d3N1e32GjJWltLnL2N7W2N/a2tzc2drd3M7EspuMhnV6eHuFjaOrw9ff2t3g393g2tnX3eHIq456ZnKFmbC1pZJ6c4CRqLzZ29PW2dnV0NPR1Nh7Z2l0Z2JqaG9tgIuQm6a4vM/g2uDa2cy/vMDL2t3bybOckIeAfn+EiJGZrcbV3tfd3Nva3dvd1tng3L+ql5eapbrBs5Z/Z2Zpgpi71trb2NnT1tHU1dTSlYRuYFxdVF1fZ3V8h5ics7nH2+Te1rmtn5ujsczb28S0nZWIe315gYeTnLO7z9zd3N/b3ODc29nc3N7bz8DAvcnYw66Od2FhYn2cuNDX1tra2Nnc2NHV1I52Z1dbVVhWUltqeH6Llaa0w9TZ18KnkIB8iJqy0+DIvKCUgn59dHeCjZemucjZ3N7g2d/f4Nvc3Nvf3Nnc2NfY28qvmIRrbXmKpsHZ1trZ2dzT2tjU1tR2aVpQV1NWVlRUWW14ipSjs73N2dStlHVfXm+JosrUx7ChkH92cnByeoSZn6/A09vf2N/i39zb4Nfa19zh2t/Y2tnXt52Nh4GOma3O19bZ1NTV19ra1tfVZl5UVlNSVlNRWF1qeISLoK+/wq2cn4BgSktbepjEycCxm419a2djZ3GBkZ+wv8/b2NbT1tHU2N7Z2dne3+Hj2Nva1cCmmY+KlaGwvsrV2trY2NDY1dbT0GRXUU9TV1ZVWFZXanaBlaKqv6t5b4V4WEtIUXSZwM2/qJqHd2pnZGVneYmarLvE0M3Ny8vLz87N1tbW3tzd3dvf3M2/qKCRlJagp7q90dbU3Nnf2tnY09JlWVFUVVhWU1dTXWdtiZCjsLupjIKUgWJKRlt/nsPKvK2Rh3liY2pnZ3qNm6q1wcjFwsTAwL7DyMvS0trX3N/e29jGsqKWkYyMkJ+mt8ba1NrY2NXW29rTbFpaWFlVVVNRVWRxd4SSoKy8zb+8rYhyYGJzkq3Q0Lqkmoh4aWRjZ2l8kZentLq9v7W8tLe1uMHDycnS1t3e3t7Pv6qei4N5e4CGmqa1zdzb1tPQ1tbX2n5mXVtbXFhYWmBqdnuKl6S0wszg3cChkIKBkaTA38+6r5+PfnBsZW57ipKdqK+5ubevsKuss7GwuL2/y9TX4NffzL6kkYBxaGpwfY2ctsHa2dzY3Nrb3diefHRwamhmYGlobn2Gkp2nucHS2dnVurCfp67E3NnTwK+llYmBend5iYySpa2ptKqspaGmoaamsLO0tsTH1d7d4Ma2pIh6Z11bX3KBlqW+09nZ09bY197NpKOJgHt5fHF0cnuLkZqnsLzF0dvc2trPxMHL4eDf2Mq5rJ2Ni4aHiZGYnKCmra6roZ+el5yanaSmrrC6wMnb293IsaOHel5eW1hkfI2dvcrZ3tTX2tq+o7OlnZGRhIF9gX6HjZueqbXE09ve4t3e3N3b5ODg297Nv7GoqJiYmZuenaitqamimpuXl4yTlJSWn6unsbnDz9PXx7GginBgVVpeWnaNnbTE29bY2ti3nIC3qqahlpCNjYiQmJqgqbO7x9Le4t3j2+Db3t7Y3d/f1MfCs7Spp6WlqKiuq6yooJCWh4WFhI2LjJSZoay1vMLN29C4pYh3ZFtdW2F1hp23ytna397Kp4Jkv761saGknZqal56hqbO6x83Z297e4N3c3+Ph2d/d3uHXzL+8tre5srKzrK2knpePjYaAgIJ9gYeQjpysrbzHzNrUuqmainFbW1Zpf4qes8jc29zXvZt4Y8zAw7ixr6imqqWoqrPAw9LW3trg5N3Z3uDc5Nvh4+Dj4djQ0cLGxMHBuLKyqJuPh4N9eHVydnh+g42SnaOyuMLM1MS1oZB7cWRucYaVq7rK4d7d3LmXiYDaz8vAwLqzuLi2tbzBxs7X2N3a3d3g3N7a4uXe4OHe4t7f39nT2dfNxsCzraGZkYV+eHBjbGtweXyGiJyhq7XCxNrRvbCdjn9/fYCNnarBz93b3NfFtKilnZyYlpKOiIODiYiQj5mZoKKiop6ioaCjoKCppKehop+fn6WhoaKll4+Aem1lVU5EOTQrKycqJTI1QExYYWVxfYqQm499b2FSTlFXXW53iJufnJ6bm5aJlJqgm5qZlpSOjJGSlZukpKGlp6acn6OlnqmgoJympqakpKSppqefnpyPhHdtYFlHPzApKCgpLiUmMz1IVF1keX2HkpqZi35zZWVfaXV0hpeeo5qcoKKcmZ6inpuZpp+ZmaKjn56io6Gdoqmen5+fp6Wfn6KhpKSeqaGopKOdoqebi3p4aGFTTjIrKCcrKiooKio5Q0VVY3Z+g5OXppmKfXl4dIF7iZSfnp2hoZ2bmZ2XmqOanKCfnaCen52hoaCioaChoJqfoaKjpqenoqacn6ijo6Wlo6SfmpGGeWthVEAwIy8qLSQoKyssOD9KVl5wdYCNnaOjnpiOg4KIjZOfo56jo5WcoJ2doJ+blZ+hoKChoZ2gop6hpKejqKGhpqGhn6Kin5+kpqKho5eip6eio5aMhXd0Z1pGLCQiKysrKC4pLDQ/R1VgbHR+ipaln6OgnZaemZ2inZ2gnJ+jm56gmZ6dmJ2goZ6joJ+dnqGgpKKhqKCjpqOlpZ6noqOoo6Oloqako6GmnqKblI9+dmNgSjMoJCssKyQjKDIxPlFZZG14goyRoaWfpKGfpKCcnKOhnaGeo5yampqb1tfW3N7X397f2tng1tvb29vd3d7b3uDf3N3h3t7f4uHq5OLi3uDj4dLGvbCmnpZ9dmxlZmZnYGhxc32Nm6SlubvJ0+Li3t/b3uHd2+Db3d3c2tva2tPY2N3d1dbc29nY2trY3uHc3tfa2ODh293b3drh3dzc3uPg4N7d4ePk4N3Uy8G2rqOZkYR+c2xuZ3BodX2LkZaiqbTCy9rW3uDi3t7f5t/a2t3Z3tzb29bY2dnZ2uDV3tzZ3Nrb3d7d4Nnh3tvh393e3drf4N3f2OPd3OLj4ePg3+XZ1s/IvLCmn5OMhHl0cnJ2dHWFhZWZoq61xM7P3tre39ve3d7d2t7d1trY2tPY4NXZ3trd2dbY3Nnb2dfU39jZ3d3c3+Dd3OHe3d7j5t/e4uHj4N7k3t7e4drS0MO5sKqZk4+Fgnx9foGFiomYn6ivvcXN2eDb4d/g3Nza293c3dfb39rc2d3a2trg2N/W293a3+Dc3NvY3N7g3dzd3eHg2N/h2OHf497f3+Dj4ePg4OHj3NXEvbWwpJmYjYqLiYKNjJKNm6WrtL/J09fe3ebf3N3Y3eDg49vY29zb3tnb3drd39vX39ja19nY3Nja3OHc2dvl2trf3+Ha397k49rj39/f29/d4d/h3dzZyMe+s6yhnpOVkI+Kk5mYnaqssrXHy9fh4N/d3t7e2dra4N3W39/b4d3d39vY19fZ2djg3d3c3dzb3djc3t7c3eDc3OPd3t7h39zc2+Hf4uLe4uDk4uLl3dLMwsOzrKWnmZqZmJqgnaSttLy/w9Le3+Dd3N/Y397f29/e3tnY1tvY3NjW2NrY2drZ2NvW2tnc3dzd3Nzf2tzf4N/c3+Hc5eHc5d3j3d/a3dzg5OHb5t7c1c7CwbaxpKyjoKekpKissby+x8vT3dze4uXc4dzg3dzd2NjU4eDb39vX2dXZ29vX29fY1t3c3eHi3OHc3N7e3t3g2eLd3t7c4t7e4uPf4OHh4t7g3uTi4tzSyMPBuLqzra+zr7aytLy9wsjY29ni2tzi2+Hc3uDd3d3Y3Nzg2t3b1tjZ2tjY3NzZ2t3Z3d3X4eHf4N7h3Nre397d3d3f2+Df4t3g39/h4ePl5N7Z3+Dj3dfNxsTGu7W6t7i8u7nByNHT3OLj3N/f3eLd4Nzf4eHb293f297W29zW2dzV2Nbg1tbd3dne39vf493Y3OXX393i3t/d3uLk497e4ODd3t7e3eHd3ePf3t/f2dfOxMW/wsG9x8bMyNPW3uHe3ODf2trm3NnZ2t3Z3drX393b3tnb1dTb19vd2dfa3N/e2ODY29va19jd3OHd3N/a4t/k3Nra4d/i3dze3+Hn4+Tf3d3f3eTd0tHVzs7MysTNy9bZ3uPg3OHd5Nze3N3e39nb3tzc2N7W3tXf2dfc19ra2dja19ve2dzc2d3n2tri4+He3t7g3N7a4Nnh3d7n3d3h4OPi4uTf4OLh3tni4N3d3dXX1NTU1tve4eDh49/h4ODe3d3h3t7b3t/Y3eDY2d3h2dzU1dja193a1Nzc3dbY3Nrh2dnh5ePa4Nnj3N7b5Nrg4eHd3d/g4N/e3eDi3eDj3+Hf3+Dc3tve49/k4dvi4OHg3d3d3eLf3tvi4OLc5N/f39zX19/e2Nne2djW09jZ2dzW39/X1drb4dvc2Nrg19zc4ufh2ODj3eLh39jc5OTd4tvf5OLg4Ojh4eDi4eDi3+Di4dzh3N7b3uHf3eHh3Nfb3dzb4N3g4Nvd3t3b29rg3N7a2Nfa1NnZ197X3drc3dzY3dne3tnc3eHZ3t7j4+Lc4eDg4OHg4eXh4+Le4uHh3N7f3dzh3tzf4N3d3N/h4+Db3t7o5N3c1tzh297c4eHe2tjZ4tvd09jb293b493g2d3a3tPY29ve29zQyMDX4dvb4t/b5d7f5Nzf3uPc4uHi3Nrh5OTh4+bh4t3o3eLf5Nza4tzi4ODb39/h39/h49rc39zZ2tzc297e3Nfc1uDX1tjX1Njc1trY3drY2Nzc4drTrZOZudnf4eDf4uPa393e3N7m3eLh2uLj5eHl4ePd3uLb2+Lf3d7d3d3d2tvf3tve4N/c3uDe3dvd3N/b3Nnd3dnc2tjW2tbe29na3NLZ19rV3dfc3dnbv5V2dp/K3eDi3t7g2+Lj3eHg3eLe4uDd4Nri4eLf4OHi5ODk3tvf3N/e3t7b3t7g49zY2t7c4d7a2tnk2dnZ2djb2djb3dva2NfY29fa2tnV09ve2dje3cKXen+r0uDe3NfZ49vk4eTd4OHf2t/k29/n3+Hh4d7Z4OXj3eLe39nc4Nzf3d/h3tnc2Nnf39/e3+Hi29rc393a1tLL0srHz9DX1tXY2tna1ODe2dje2dvStp+jw9nd397g4Nnd4Nvg39vj3N/e3+Xh5N/e3+He5OLi49zd2+Dk4tzd5d3a2t/c3d7c3t3d4tbd3t7d3dfSzsK9vLm2t8HF2trX1tzW29zc29vd4Njb2NfJzdvc3t7j3OHf3d3b39/f4tvb3uLd49/i39vf3N7g3t3j4+Lb4N3b19vg3d3j29ja19zc4drX29vg2dPJtLStpp2moq6utdrT2dLU3NfZ29jb3Nve4tnY2N3i2dnb39ra29ve39rc3eDi3+Da397d4Nre2d7f4t/c3OTg397h2d7d4tvc4+LX29/f2dnh3t7a2c/Etaudj46JjZCUoqrZ2NnZ2Nja3dvT19XX29nc19rY297Y3ODf293b4t/i2uPc3uLd4N3h3uPf39zc3eDi5t/d3eHf3+Te3N7b4d7d4N3b2uDe393f2M2/r5+Ui4V3d3N5jZSf19Pa1NnZ2NzV2t7b3dvc29fZ3dze297i3N3f4t/g3t/h3+Hf293d4N7d4eHe4+bh3d3j4Nzf4OHf3eDZ4Nnb2t3X1+Dc4djX19TFsaKViHJlZmNocn6Jm9jY1tTZ19ja2tzY29vc29zZ1tnY3d3i293c1+Df2OHa4t3a2uHg3t3j2dve3t/h397g3trf2tve2t/h4d7e397d3tvd4drc2NTJsKiShnJiY2BiWmmCjJ7c0tfV29rX3tvW3dfe4Nfc2dnc3eLc3dff3tzd19TK19/d3t3i2uHk3t/i3N3d4OLi393d4Nvb2tza3+Ha4N7e3djb2N3a3NPQv6ygjXtsYWNcXWJ3hpmq09fW19jY2NnX3Nnb2tfZ3eDa29rW29vh3t3b3Lyjp8TY3uPX4ePh3N/e3N7h4eDd3OPX3Nfa3Nvf3d3e5dvb3drX2+Le29bfzruumol9amFhYGltf5Chs9nb2tjX1tfX3drW19jd2tfb2djf3t/Z3N3Z2rmMeo613d7e3+DY2dfg3eLg3OHb3Nrg2OLi4tze2t/Z3Nje2trc29rY39zd28y8rKCMgXJ1bnB6gpGgrLjW19nV0dba19nZ1t3f2Nnb3NrW39vb4d3c3MuUYmGJvtfn3dze3eDb3Nvg3eLh2tvb3NnR0s/OzdLP1NTg2+Da3tbf3NjX2tvKwbOmnIqMgoOHkZqjsrvG19fZ1dzU3drX1dba1dja3dzd3Nnb2tja2Ni2eGRqn9Te3tnd29zc3uTg29za3tfa1dbLysnAwr3DwcfHztva3N3c3+DX2tne2cW5ra2im5qanaOutsDN2NvU1tnV29ra193Y2trd09Xd1dvW3dff19vcroF2j7/e2tfb3tnf39ne1tjf29rZ0crDv7i3uK6xsLe6vMXIyNXd3dzh2d7c2tvVybm7q6+vs7O1wsnW0tXU3tbY1drW2dfZ29jj2NjX2tzZ2djc29rb2LKbo77e3dfh29/c3d/b2drh3NjWysC+uK6mn6OjnaebpLC2tMPN1Nrb1tra19bY2NjOysi/w8TH0tfb1drS19PY2NrV2NXV19La1trW2dbc29na19nf29/RvNLd39zU3eLb2d3d2OHj3NnUzru5raSgnZaUl5CPlZehoaixvMjS3dzY2t/X19XY1tbX2NvY19fW19fU1dPX1tfd1N7a2tjb29vR1d3e2tnb19/b293Y2t3d3tra3Nvf2d3e5Nng39za0MOyr6WZmoqKg4CBgYCHjZWioqy7xM7c4NzX2djY2NfX2NzZ29fY09bZ1NbW0dTaz9nX3dba1Nva19vZ1tjT19jf2Nzc3tnb2Nze3tjW2drd3d3U293bz8TCsKeZkYiDenVucXJweHyKk56lsrzE0tjV3N3a2NXY1NbY0tHU0NTW0tfZ19XT187U0tLa19TR2dfX1tnZ0tfY1dff1dre3t7a3OLW09ja3djX2dva2M+9saiel4iBfHNnZl5jaXJ1gomTnqG1vcvW19bZ1tjY1dbU2NXZ09fWz9Tc1dLV0dPY19TU1NfZ1dTT09vX0dzb2N7b1djZ29jU2t7U2NTY2tfb1dnc29nFvq6elo1/dW1cXFhTWFpbZXB6ipWYq7vGztbS2NnV1tvX2dbS2NbX1NPV2dbV0dnV19jS1dfX09TR0tjc2Nne1tTe2tnZ3djc19Xa2tvX19re3Nvc3tfRx7uun46FfGtfU1BJSlBOVWJodX+MlKKtt8TQ09vc3NjW0tTd1NLW0djQ1dDT1NbY19bX2Nja1NbW2dTU1tTZ2dbd2trY2t/Y29nV1dbX3tjb2dra09jUz8a0qJ2MhHJtXU1HTUNGSUtRXHF2gZecqrjF09jY2NnZ09ba1dfV0tPV2NXR1tPM19fX2NHV2tXT0tXT1NPZ1NrW29XW3dXZ39fb19fX29rY2Nrc29nd4tTItKWbjoF2ZlpPSEtLSElOTVpmdIGRnqm3xM3W2tvT2dfa19LS1tjR0NTT29DQz9DS1tXW0dPW1dTV2drb193X2drW2Nfe29TZ297Z0tnd2tbY2N/a1tjVurCmm4mFcmNYRkhPRklJSFBiYXJ9jJywtMDJ1drV0tPQ09jZ2tPS2M/X1tHR", "variants": {"legacy_poly": {"settings": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "analysis_polygon": [[6.5, 4.25], [84.2, 8.7], [80.6, 66.2], [10.3, 62.9]], "threshold_percent": 62.0}, "poly_hash": 694782288, "thr_count": 510, "thr_hash": 2930269597, "bg": 216.0, "thr_pct": 62.0, "model_info": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "axis_method": "max_radius", "volume_model": "legacy", "flattened": false, "threshold_percent_used": 62.0}, "cols": {"cluster_id": [0, 1, 2, 6], "surface": [153.0, 34.0, 79.0, 8.0], "roundness": [0.4477950884702996, 0.43802435986862676, 0.6345335704288599, 0.6652027009228604], "short_axis": [4.669930765828349, 2.177276845191569, 3.994532059961138, 1.301508650819981], "long_axis": [10.428722614580636, 4.970675251587795, 6.295225731337379, 1.956559480312316], "volume": [714.4994071717373, 74.02741273651336, 315.56803273692987, 10.412069206559847], "xmean": [26.790849673202615, 13.029411764705882, 20.911392405063292, 59.75], "ymean": [52.39869281045752, 23.970588235294116, 72.16455696202532, 28.125]}, "n_px": [153, 34, 79, 8], "px_hash": [2493639876, 3978285882, 9676538, 4134751876], "layer_hash": 2834871176, "n1": 137, "n2": 4}, "moments_spheroid": {"settings": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "axis_method": "moments", "volume_model": "spheroid", "threshold_percent": 62.0}, "poly_hash": null, "thr_count": 803, "thr_hash": 2517855928, "bg": 214.0, "thr_pct": 62.0, "model_info": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "axis_method": "moments", "volume_model": "spheroid", "flattened": false, "threshold_percent_used": 62.0}, "cols": {"cluster_id": [0, 3, 5, 6, 7, 8, 9, 12], "surface": [152.0, 30.0, 79.0, 15.0, 44.0, 18.0, 8.0, 9.0], "roundness": [0.42196449241510764, 0.8681178714103384, 0.5058736602415286, 0.8425849928394462, 0.6018160518705183, 0.845580837944509, 0.4703846392786471, 0.9549296585513722], "short_axis": [4.518401417785565, 2.879221253270089, 3.566643014092359, 2.0057534737757314, 2.9032423176299376, 2.2010954829665157, 1.0944517567856138, 1.6539866862653763], "long_axis": [10.708013349475353, 3.3166247903554, 7.050461991615596, 2.380476142847616, 4.82413572819519, 2.603057430105768, 2.326716617413353, 1.7320508075688772], "volume": [915.7293540045413, 115.16885013080356, 375.6863974843951, 40.11506947551463, 170.32354930095633, 52.82629159119637, 11.674152072379878, 19.847840235184517], "xmean": [26.81578947368421, 13.0, 20.911392405063292, 5.466666666666667, 55.86363636363637, 8.722222222222221, 59.75, 2.0], "ymean": [52.43421052631579, 24.5, 72.16455696202532, 62.13333333333333, 80.97727272727273, 70.88888888888889, 28.125, 73.0]}, "n_px": [152, 30, 79, 15, 44, 18, 8, 9], "px_hash": [1342718187, 3715613964, 9676538, 1943123267, 1286103326, 3680656081, 4134751876, 1883386521], "layer_hash": 2495517800, "n1": 197, "n2": 8}, "quick_roundness": {"settings": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "quick_mode": true, "min_roundness": 0.5, "analysis_polygon": [[6.5, 4.25], [84.2, 8.7], [80.6, 66.2], [10.3, 62.9]], "threshold_percent": 66.0, "min_surface": 3.0}, "poly_hash": 694782288, "thr_count": 642, "thr_hash": 2629835007, "bg": 216.0, "thr_pct": 66.0, "model_info": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "axis_method": "max_radius", "volume_model": "legacy", "flattened": false, "threshold_percent_used": 66.0}, "cols": {"cluster_id": [2, 6, 9], "surface": [104.0, 11.0, 4.0], "roundness": [0.6721708548433757, 0.7304663077769427, 2.5464790894703246], "short_axis": [4.717170480630379, 1.5992689330394987, 1.8006326323142121], "long_axis": [7.0178146622104585, 2.1893808325076867, 0.7071067811865476], "volume": [490.58572998555945, 17.591958263434485, 7.2025305292568484], "xmean": [20.903846153846153, 59.36363636363637, 48.5], "ymean": [72.25961538461539, 28.454545454545453, 17.5]}, "n_px": [104, 11, 4], "px_hash": [466298585, 458038724, 660663653], "layer_hash": 3799313611, "n1": 64, "n2": 3}, "full_nopoly_smooth5": {"settings": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "smoothing_window": 5, "max_cost": 0.1, "max_cluster_axis": 30.0, "threshold_percent": 70.0}, "poly_hash": null, "thr_count": 1125, "thr_hash": 1336746006, "bg": 214.0, "thr_pct": 70.0, "model_info": {"background_model": "global", "threshold_mode": "fixed", "edge_correction": false, "axis_method": "max_radius", "volume_model": "legacy", "flattened": false, "threshold_percent_used": 70.0}, "cols": {"cluster_id": [0, 3, 5, 6, 7, 8, 11, 12], "surface": [94.0, 30.0, 78.0, 21.0, 65.0, 13.0, 6.0, 15.0], "roundness": [0.48075161065008787, 1.0323563876231052, 0.628320756658585, 0.9898817514936474, 0.6873558307966344, 0.8719785784860201, 1.3750987083139736, 0.26823866813240804], "short_axis": [3.7927076217470455, 3.1397893762739235, 3.949690527881239, 2.5723281479469993, 3.771139106087404, 1.8995452684639167, 1.6205693690827896, 1.131700180635214], "long_axis": [7.889120988317488, 3.0413812651491097, 6.286105442203956, 2.5986216475509067, 5.4864437560916794, 2.178431116693276, 1.1785113019775801, 4.219004621945796], "volume": [356.51451644422224, 94.19368128821769, 308.07586117473664, 54.018891106886976, 245.12404189568127, 24.694088490030914, 9.723416214496735, 16.97550270952821], "xmean": [26.5531914893617, 13.0, 20.91025641025641, 5.380952380952381, 55.707692307692305, 59.46153846153846, 48.166666666666664, 24.4], "ymean": [52.244680851063826, 24.5, 72.14102564102564, 62.476190476190474, 80.98461538461538, 28.384615384615383, 17.166666666666668, 8.2]}, "n_px": [94, 30, 78, 21, 65, 13, 6, 15], "px_hash": [331081348, 3715613964, 1255715756, 2199934100, 1489381213, 123929805, 542929548, 921406304], "layer_hash": 347427668, "n1": 195, "n2": 8}}, "square": {"cluster_id": 0, "surface": 36.0, "roundness": 0.916732472209317, "short_axis": 3.241138738165582, "long_axis": 3.5355339059327378, "volume": 116.68099457396094, "xmean": 12.5, "ymean": 12.5}, "square_moments": {"cluster_id": 0, "surface": 36.0, "roundness": 0.9549296585513722, "short_axis": 3.3079733725307525, "long_axis": 3.4641016151377544, "volume": 158.78272188147614, "xmean": 12.5, "ymean": 12.5}, "radius": {"n": 8, "pts": [[20.0, 30.0], [50.5, 60.2]], "r": 12.0, "ids": [3], "ids0": [], "ids_big": [0, 3, 7]}}
const CLOSE = {"res": {"True": [[1, 81.0]], "False": [[0, 46.0], [1, 81.0]]}, "blue": "yMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIKMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyCjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKMjIyMjIyMjIyMjIyMjIyMjIyMjIyCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyCgoKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCgoKMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMgoKCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKCgoyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIKCgoKCgoKMjIyMjIyMjIyMjIyMjIyMjIyMjIyCgoKCgoKCjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIKMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyCjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjI"}

const fnv = (arr) => {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  let h = 2166136261
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0
  return h
}
const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }

describe('settings', () => {
  it('has the Python defaults', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      threshold_percent: 58.8, reference_threshold: 0.4, max_cluster_axis: 100, min_surface: 5,
      min_roundness: 0, max_cost: 0.35, smoothing_window: 3, quick_mode: false,
      analysis_polygon: null, pixel_scale: null, background_model: 'poly4', threshold_mode: 'half_contrast',
      edge_correction: true, axis_method: 'max_radius', volume_model: 'legacy',
      min_diameter_um: null, reference_px_length: null, click_sigma_px: 2.0,
    })
  })
  it('makeSettings merges overrides and ignores undefined / unknown keys', () => {
    const s = makeSettings({ threshold_percent: 50, quick_mode: true, smoothing_window: undefined, bogus: 1 })
    expect(s.threshold_percent).toBe(50)
    expect(s.quick_mode).toBe(true)
    expect(s.smoothing_window).toBe(3)
    expect(s.bogus).toBeUndefined()
  })
  it('validates the enums with the Python messages (status 400)', () => {
    for (const [name, allowed] of [
      ['background_model', 'global, poly4'], ['threshold_mode', 'fixed, half_contrast'],
      ['axis_method', 'max_radius, moments'], ['volume_model', 'legacy, spheroid'],
    ]) {
      let err
      try { makeSettings({ [name]: 'nope' }) } catch (e) { err = e }
      expect(err.message).toBe(`${name} must be one of ${allowed}.`)
      expect(err.status).toBe(400)
    }
  })
  it('legacySettings reproduces the original behaviour switches', () => {
    expect(legacySettings({ smoothing_window: 5 })).toMatchObject({
      background_model: 'global', threshold_mode: 'fixed', edge_correction: false,
      axis_method: 'max_radius', volume_model: 'legacy', smoothing_window: 5,
    })
  })
})

describe('polygon / median helpers', () => {
  it('buildPolygonMask: null stays null, <3 points throws', () => {
    expect(buildPolygonMask([10, 10], null)).toBeNull()
    let err
    try { buildPolygonMask([10, 10], [[1, 1], [5, 5]]) } catch (e) { err = e }
    expect(err.message).toBe('An analysis polygon must contain at least three points.')
    expect(err.status).toBe(400)
  })
  it('buildPolygonMask accepts [x, y] pairs and {x, y} objects alike', () => {
    const a = buildPolygonMask([30, 40], [[5, 5], [30, 8], [20, 25]])
    const b = buildPolygonMask([30, 40], [{ x: 5, y: 5 }, { x: 30, y: 8 }, { x: 20, y: 25 }])
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(sum(a)).toBeGreaterThan(100)
  })
  it('medianU8 equals the sort-based median (mean of the two middle values)', () => {
    let s = 99
    for (const n of [1, 2, 3, 4, 10, 11, 255, 1000, 1001]) {
      const v = new Uint8Array(n)
      for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = s >>> 24 }
      const sorted = Array.from(v).sort((x, y) => x - y)
      const exp = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      expect(medianU8(v, n)).toBe(exp)
    }
    expect(Number.isNaN(medianU8(new Uint8Array(0), 0))).toBe(true)
  })
  it('backgroundMedian over the whole image or only the polygon; empty polygon throws', () => {
    const blue = new Uint8Array(100)
    for (let i = 0; i < 100; i++) blue[i] = i < 50 ? 10 : 200
    expect(backgroundMedian(blue, null)).toBe(105)
    const mask = new Uint8Array(100)
    mask.fill(1, 60)
    expect(backgroundMedian(blue, mask)).toBe(200)
    let err
    try { backgroundMedian(blue, new Uint8Array(100)) } catch (e) { err = e }
    expect(err.message).toBe('The selected analysis polygon does not contain any image pixels.')
    expect(err.status).toBe(400)
  })
})

describe('analyzeImageBlue on a hand-made image', () => {
  const b = new Uint8Array(30 * 30).fill(200)
  for (let r = 10; r < 16; r++) for (let c = 10; c < 16; c++) b[r * 30 + c] = 40
  const settings = legacySettings()

  it('finds one 6x6 square with the exact Python values (REF)', () => {
    const res = analyzeImageBlue(b, 30, 30, settings)
    const ds = res.dataset
    expect(ds.n).toBe(1)
    for (const k of ['cluster_id', 'surface', 'roundness', 'short_axis', 'long_axis', 'volume', 'xmean', 'ymean']) {
      expect(ds[k][0]).toBe(REF.square[k])
    }
    expect(ds.px_len[0]).toBe(36)
    expect(res.background_median).toBe(200)
    expect(res.threshold_percent_used).toBe(58.8)
    expect(res.polygon_mask).toBeNull()
    expect(sum(res.threshold_mask)).toBe(36)
    expect(res.model_info).toEqual({
      background_model: 'global', threshold_mode: 'fixed', edge_correction: false, axis_method: 'max_radius',
      volume_model: 'legacy', flattened: false, threshold_percent_used: 58.8,
    })
    expect(ds.meta).toEqual({
      min_surface: 5, reference_px_length: null, click_sigma_px: 2, min_diameter_um: null,
      image_shape: [30, 30], threshold_percent_used: 58.8, background_model: 'global', threshold_mode: 'fixed',
      edge_correction: false, axis_method: 'max_radius', volume_model: 'legacy',
    })
  })
  it('moments + spheroid use the second-moment axes (REF)', () => {
    const ds = analyzeImageBlue(b, 30, 30, legacySettings({ axis_method: 'moments', volume_model: 'spheroid' })).dataset
    for (const k of ['surface', 'roundness', 'short_axis', 'long_axis', 'volume', 'xmean', 'ymean']) {
      expect(ds[k][0]).toBe(REF.square_moments[k])
    }
  })
  it('does not modify the input blue channel', () => {
    const copy = b.slice()
    analyzeImageBlue(b, 30, 30, settings)
    expect(Array.from(b)).toEqual(Array.from(copy))
  })
  it('reports progress phases in order', () => {
    const phases = []
    analyzeImageBlue(b, 30, 30, settings, { onProgress: (phase, f) => { if (!phases.includes(phase)) phases.push(phase); expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThanOrEqual(1) } })
    expect(phases).toEqual(['detect', 'measure'])
  })
  it('clusters touching the image border are rejected', () => {
    const edge = new Uint8Array(30 * 30).fill(200)
    for (let r = 0; r < 6; r++) for (let c = 10; c < 16; c++) edge[r * 30 + c] = 40
    expect(analyzeImageBlue(edge, 30, 30, settings).dataset.n).toBe(0)
  })
  it('min_surface rejects small clusters; empty result is a valid empty dataset', () => {
    const ds = analyzeImageBlue(b, 30, 30, legacySettings({ min_surface: 40 })).dataset
    expect(ds.n).toBe(0)
    expect(ds.px_row.length).toBe(0)
  })
  it('a polygon with no thresholded pixel inside throws the Python message', () => {
    let err
    try {
      analyzeImageBlue(b, 30, 30, legacySettings({ analysis_polygon: [[1, 1], [8, 1], [8, 8], [1, 8]] }))
    } catch (e) { err = e }
    expect(err.message).toBe('No thresholded pixels were found inside the selected analysis region.')
    expect(err.status).toBe(400)
  })
  it('reference_threshold < 0 is rejected in full mode only', () => {
    let err
    try { analyzeImageBlue(b, 30, 30, legacySettings({ reference_threshold: -0.1 })) } catch (e) { err = e }
    expect(err.message).toBe('reference_threshold must be >= 0.')
    expect(analyzeImageBlue(b, 30, 30, legacySettings({ reference_threshold: -0.1, quick_mode: true })).dataset.n).toBe(1)
  })
  it('repeated runs are deterministic and leave module state clean', () => {
    const a = analyzeImageBlue(b, 30, 30, settings).dataset
    const c = analyzeImageBlue(b, 30, 30, settings).dataset
    expect(Array.from(a.surface)).toEqual(Array.from(c.surface))
    expect(Array.from(a.px_row)).toEqual(Array.from(c.px_row))
    // a different image width afterwards (shared index grid buffer must have been reset)
    const wide = new Uint8Array(20 * 50).fill(200)
    for (let r = 5; r < 11; r++) for (let c2 = 20; c2 < 26; c2++) wide[r * 50 + c2] = 40
    expect(analyzeImageBlue(wide, 20, 50, settings).dataset.n).toBe(1)
  })
})

describe('analyzeImageBlue vs Python on a synthetic grind image (REF)', () => {
  const blue = b64(REF.blue)
  for (const [name, v] of Object.entries(REF.variants)) {
    it(`variant ${name}`, () => {
      const res = analyzeImageBlue(blue, REF.h, REF.w, legacySettings(v.settings))
      const ds = res.dataset
      if (v.poly_hash !== null) expect(fnv(res.polygon_mask)).toBe(v.poly_hash)
      else expect(res.polygon_mask).toBeNull()
      expect(sum(res.threshold_mask)).toBe(v.thr_count)
      expect(fnv(res.threshold_mask)).toBe(v.thr_hash)
      expect(res.background_median).toBe(v.bg)
      expect(res.threshold_percent_used).toBe(v.thr_pct)
      expect(res.model_info).toEqual(v.model_info)
      expect(ds.n).toBe(v.cols.cluster_id.length)
      expect(ds.n).toBeGreaterThan(0)
      for (const k of Object.keys(v.cols)) expect(Array.from(ds[k])).toEqual(v.cols[k])
      expect(Array.from(ds.px_len)).toEqual(v.n_px)
      for (let i = 0; i < ds.n; i++) {
        const lin = new Float64Array(ds.px_len[i])
        for (let j = 0; j < lin.length; j++) lin[j] = ds.px_row[ds.px_start[i] + j] * REF.w + ds.px_col[ds.px_start[i] + j]
        // Python hashes int64 linear indices
        const bytes = new BigInt64Array(lin.length)
        for (let j = 0; j < lin.length; j++) bytes[j] = BigInt(lin[j])
        expect(fnv(bytes)).toBe(v.px_hash[i])
      }
      const layer = clusterIndexLayer([REF.h, REF.w], ds)
      expect(fnv(layer.index)).toBe(v.layer_hash)
      expect(layer.index.filter((x) => x === 1).length).toBe(v.n1)
      expect(layer.index.filter((x) => x === 2).length).toBe(v.n2)
    })
  }
})

describe('polygon border handling (CLOSE_POLYGON_EDGES)', () => {
  const blue = b64(CLOSE.blue)
  const poly = [[12, 5], [55, 5], [55, 45], [12, 45]]
  const run = () => analyzeImageBlue(blue, 50, 60, legacySettings({ analysis_polygon: poly })).dataset
  it('the closing edge rejects the particle cut by it (default, REF)', () => {
    const ds = run()
    expect(Array.from(ds.cluster_id)).toEqual(CLOSE.res.True.map((r) => r[0]))
    expect(Array.from(ds.surface)).toEqual(CLOSE.res.True.map((r) => r[1]))
  })
  it('setClosePolygonEdges(false) restores the reference behaviour that kept it (REF)', () => {
    setClosePolygonEdges(false)
    try {
      const ds = run()
      expect(Array.from(ds.cluster_id)).toEqual(CLOSE.res.False.map((r) => r[0]))
      expect(Array.from(ds.surface)).toEqual(CLOSE.res.False.map((r) => r[1]))
    } finally {
      setClosePolygonEdges(true)
    }
    expect(run().n).toBe(CLOSE.res.True.length)
  })
  it('polygonEdgeGrid flags only the given thresholded pixels near the border', () => {
    const rows = Int32Array.from([25, 25, 25])
    const cols = Int32Array.from([12, 30, 54])
    const g = polygonEdgeGrid([50, 60], rows, cols, 3, poly)
    expect(g[25 * 60 + 12]).toBe(1) // closing edge (12,45)->(12,5)
    expect(g[25 * 60 + 30]).toBe(0)
    expect(g[25 * 60 + 54]).toBe(1) // near x=55 edge
    expect(polygonEdgeGrid([50, 60], rows, cols, 3, null)).toBeNull()
  })
})

describe('detectParticles', () => {
  it('returns an empty dataset (no throw) for an empty mask', () => {
    const ds = detectParticles(new Uint8Array(100), 10, 10, new Uint8Array(100), 200, legacySettings(), null)
    expect(ds.n).toBe(0)
  })
  it('min_roundness filters on the recomputed roundness', () => {
    const blue = b64(REF.blue)
    const mask = new Uint8Array(REF.h * REF.w)
    for (let i = 0; i < mask.length; i++) mask[i] = blue[i] < 0.62 * 255 ? 1 : 0
    const all = detectParticles(blue, REF.h, REF.w, mask, 200, legacySettings(), null)
    const rnd = detectParticles(blue, REF.h, REF.w, mask, 200, legacySettings({ min_roundness: 0.5 }), null)
    expect(rnd.n).toBeLessThanOrEqual(all.n)
    for (let i = 0; i < rnd.n; i++) expect(rnd.roundness[i]).toBeGreaterThanOrEqual(0.5)
    // surviving clusters keep their original cluster_id
    const ids = new Set(all.cluster_id)
    for (let i = 0; i < rnd.n; i++) expect(ids.has(rnd.cluster_id[i])).toBe(true)
  })
})

describe('remeasureClusters', () => {
  const mk = () => makeDataset({
    n: 1, cluster_id: [0], surface: [4], roundness: [0.5], short_axis: [0.3], long_axis: [1.2], volume: [0.7],
    xmean: [10.5], ymean: [20.5], px_start: [0], px_len: [4], px_row: [10, 10, 11, 11], px_col: [20, 21, 20, 21],
  })
  it('is a no-op for max_radius + legacy', () => {
    const ds = mk()
    remeasureClusters(ds, 'max_radius', 'legacy')
    expect(ds.long_axis[0]).toBe(1.2)
    expect(ds.volume[0]).toBe(0.7)
  })
  it('moments: 2x2 block has sxx = syy = 0.25 + 1/12 (per-pixel sum order)', () => {
    const ds = mk()
    remeasureClusters(ds, 'moments', 'legacy')
    const s = 0.25 + 1 / 12
    const lam1 = 0.5 * (s + s) + Math.sqrt(Math.max(0.25 * 0 + 0, 0))
    expect(ds.long_axis[0]).toBeCloseTo(2 * Math.sqrt(lam1), 14)
    expect(ds.short_axis[0]).toBeCloseTo(4 / (Math.PI * ds.long_axis[0]), 14)
    expect(ds.surface[0]).toBe(4)
  })
  it('spheroid volume is 4/3 pi L s^2 while max_radius keeps long_axis', () => {
    const ds = mk()
    remeasureClusters(ds, 'max_radius', 'spheroid')
    expect(ds.long_axis[0]).toBe(1.2)
    expect(ds.short_axis[0]).toBe(4 / (Math.PI * 1.2))
    expect(ds.volume[0]).toBeCloseTo((4 / 3) * Math.PI * 1.2 * ds.short_axis[0] ** 2, 12)
    expect(ds.roundness[0]).toBe(0.5) // roundness only recomputed for moments
  })
  it('does nothing on an empty dataset', () => {
    expect(() => remeasureClusters(makeDataset({ n: 0 }), 'moments', 'spheroid')).not.toThrow()
  })
})

describe('clustersWithinRadius and layers', () => {
  const blue = b64(REF.blue)
  const ds = analyzeImageBlue(blue, REF.h, REF.w, legacySettings({ threshold_percent: 62.0 })).dataset
  it('matches Python clusters_within_radius (REF)', () => {
    const R = REF.radius
    expect(Array.from(clustersWithinRadius(ds, R.pts, R.r)).sort((a, b) => a - b)).toEqual(R.ids)
    expect(Array.from(clustersWithinRadius(ds, R.pts, 25.5)).sort((a, b) => a - b)).toEqual(R.ids_big)
    expect(clustersWithinRadius(ds, R.pts, 0).size).toBe(0)
    expect(clustersWithinRadius(ds, [], 10).size).toBe(0)
    expect(clustersWithinRadius(makeDataset({ n: 0 }), R.pts, 10).size).toBe(0)
  })
  it('threshold layer is a copy of the mask with the 2-colour palette', () => {
    const mask = Uint8Array.from([0, 1, 1, 0, 1, 0])
    const l = thresholdIndexLayer(mask, 2, 3)
    expect(l.width).toBe(3)
    expect(l.height).toBe(2)
    expect(Array.from(l.index)).toEqual([0, 1, 1, 0, 1, 0])
    expect(l.index).not.toBe(mask)
    expect(l.palette).toEqual([[255, 59, 48], [80, 160, 255]])
  })
  it('cluster layer: 6x6 square has a 20 px outline and the centre (round-half-even of 12.5 = 12) overrides', () => {
    const b = new Uint8Array(30 * 30).fill(200)
    for (let r = 10; r < 16; r++) for (let c = 10; c < 16; c++) b[r * 30 + c] = 40
    const d = analyzeImageBlue(b, 30, 30, legacySettings()).dataset
    const l = clusterIndexLayer([30, 30], d)
    expect(l.index.filter((x) => x === 1).length).toBe(20)
    expect(l.index.filter((x) => x === 2).length).toBe(1)
    expect(l.index[12 * 30 + 12]).toBe(2)
  })
  it('a centre on an outline pixel replaces the outline value', () => {
    const d = makeDataset({
      n: 1, xmean: [5], ymean: [5], px_start: [0], px_len: [1], px_row: [5], px_col: [5],
    })
    const l = clusterIndexLayer([10, 10], d)
    expect(l.index[55]).toBe(2)
    expect(sum(l.index)).toBe(2)
  })
  it('non-finite centres (CSV-imported datasets) are skipped', () => {
    const d = makeDataset({ n: 1, xmean: [NaN], ymean: [NaN] })
    expect(sum(clusterIndexLayer([5, 5], d).index)).toBe(0)
  })
})
