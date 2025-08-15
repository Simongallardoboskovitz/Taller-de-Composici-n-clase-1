import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { jsPDF } from 'jspdf';
import type { UserData, PoseAngle, SavedPoseData, ZodiacSign } from './types';
import { ZODIAC_SIGNS } from './constants';
import UserSetupModal from './components/UserSetupModal';
import CountdownModal from './components/CountdownModal';

// Declare MediaPipe globals provided by script tags in index.html
declare const Camera: any;
declare const Pose: any;
declare const POSE_CONNECTIONS: any;
declare const drawConnectors: any;
declare const drawLandmarks: any;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

// --- MOCK FIREBASE FOR LOCAL DEV ---
// In a real environment, these would be initialized properly.
const mockDb = {
  listeners: [] as ((data: SavedPoseData[]) => void)[],
  data: [] as SavedPoseData[],
  addDoc: function(doc: Omit<SavedPoseData, 'id'>) {
    const newDoc = { ...doc, id: `mock_${Date.now()}` };
    this.data.push(newDoc);
    this.listeners.forEach(cb => cb(this.data));
    return Promise.resolve();
  },
  onSnapshot: function(callback: (data: SavedPoseData[]) => void) {
    this.listeners.push(callback);
    callback(this.data); // Initial call
    return () => { // Unsubscribe function
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }
};
// --- END MOCK ---

const STABILITY_THRESHOLD = 50; // Total degrees of change allowed to be "stable"
const STABILITY_DURATION_FRAMES = 45; // Approx 1.5 seconds of stability needed

const segmentsToMeasure: { name: string, landmarks: [number, number] }[] = [
    { name: 'Brazo Izquierdo', landmarks: [11, 13] },
    { name: 'Antebrazo Izquierdo', landmarks: [13, 15] },
    { name: 'Brazo Derecho', landmarks: [12, 14] },
    { name: 'Antebrazo Derecho', landmarks: [14, 16] },
    { name: 'Muslo Izquierdo', landmarks: [23, 25] },
    { name: 'Espinilla Izquierda', landmarks: [25, 27] },
    { name: 'Muslo Derecho', landmarks: [24, 26] },
    { name: 'Espinilla Derecha', landmarks: [26, 28] },
];

export default function App() {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [isCameraReady, setCameraReady] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isPhraseRecording, setIsPhraseRecording] = useState(false);
  const [countdown, setCountdown] = useState(8);
  const [useFrontCamera, setUseFrontCamera] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  const [currentAngles, setCurrentAngles] = useState<PoseAngle[]>([]);
  const [savedPoses, setSavedPoses] = useState<SavedPoseData[]>([]);
  const [snapshotImage, setSnapshotImage] = useState<string | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<any>(null);
  const poseStabilityCounter = useRef(0);
  const lastStableAngles = useRef<PoseAngle[] | null>(null);


  useEffect(() => {
    setIsMobile(/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent));
  }, []);

  const onResults = useCallback((results: any) => {
    if (!canvasRef.current || !videoRef.current) return;
    const canvasCtx = canvasRef.current.getContext('2d');
    if (!canvasCtx) return;

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    
    if (results.image) {
      canvasCtx.drawImage(results.image, 0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    
    if (results.poseLandmarks) {
      drawConnectors(canvasCtx, results.poseLandmarks, POSE_CONNECTIONS, { color: '#FFFFFF', lineWidth: 2 });
      drawLandmarks(canvasCtx, results.poseLandmarks, { color: '#FFFFFF', radius: 3 });
      
      const landmarks = results.poseLandmarks;
      const p = (i: number) => ({ x: landmarks[i].x * canvasRef.current!.width, y: landmarks[i].y * canvasRef.current!.height });
      
      const angleDefinitions = [
        { name: 'Codo Izquierdo', points: [p(11), p(13), p(15)] as const },
        { name: 'Codo Derecho', points: [p(12), p(14), p(16)] as const },
        { name: 'Hombro Izquierdo', points: [p(23), p(11), p(13)] as const },
        { name: 'Hombro Derecho', points: [p(24), p(12), p(14)] as const },
        { name: 'Cadera Izquierda', points: [p(11), p(23), p(25)] as const },
        { name: 'Cadera Derecha', points: [p(12), p(24), p(26)] as const },
        { name: 'Rodilla Izquierda', points: [p(23), p(25), p(27)] as const },
        { name: 'Rodilla Derecha', points: [p(24), p(26), p(28)] as const },
      ];

      const calculateAngle = (a: {x:number, y:number}, b: {x:number, y:number}, c: {x:number, y:number}) => {
        let angle = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)) * 180 / Math.PI;
        return Math.round(angle > 180 ? 360 - angle : angle);
      }

      const newAngles: PoseAngle[] = angleDefinitions.map(def => ({
          name: def.name,
          angle: calculateAngle(...def.points)
      }));
      setCurrentAngles(newAngles);

      if (userData) {
        const shoulder_y_px = ((landmarks[11].y + landmarks[12].y) / 2) * canvasRef.current.height;
        const hip_y_px = ((landmarks[23].y + landmarks[24].y) / 2) * canvasRef.current.height;
        const torso_height_px = Math.abs(hip_y_px - shoulder_y_px);
        let cm_per_pixel = 0;
        if (torso_height_px > 1) { // Avoid division by zero
            const torso_height_cm = userData.height * 0.30; // Anthropometric approximation: torso is ~30% of total height
            cm_per_pixel = torso_height_cm / torso_height_px;
        }

        const drawTextWithBackground = (text: string, x: number, y: number) => {
          canvasCtx.font = "bold 14px sans-serif";
          const textMetrics = canvasCtx.measureText(text);
          const padding = 5;
          const rectX = x - (textMetrics.width / 2) - padding;
          const rectY = y - 7 - padding; // 7 is half of font size
          const rectW = textMetrics.width + (padding * 2);
          const rectH = 14 + (padding * 2);

          canvasCtx.fillStyle = "rgba(0, 0, 0, 0.7)";
          canvasCtx.beginPath();
          (canvasCtx as any).roundRect(rectX, rectY, rectW, rectH, 5);
          canvasCtx.fill();
          
          canvasCtx.fillStyle = "white";
          canvasCtx.textAlign = "center";
          canvasCtx.textBaseline = "middle";
          canvasCtx.fillText(text, x, y);
        };

        const drawAngleArc = (p1: {x:number, y:number}, p2: {x:number, y:number}, p3: {x:number, y:number}) => {
            const rad1 = Math.atan2(p1.y - p2.y, p1.x - p2.x);
            const rad2 = Math.atan2(p3.y - p2.y, p3.x - p2.x);

            let diff = rad2 - rad1;
            while (diff <= -Math.PI) diff += 2 * Math.PI;
            while (diff > Math.PI) diff -= 2 * Math.PI;
            
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
            canvasCtx.lineWidth = 5;
            canvasCtx.arc(p2.x, p2.y, 20, rad1, rad1 + diff);
            canvasCtx.stroke();
        };
        
        if (cm_per_pixel > 0) {
          segmentsToMeasure.forEach(segment => {
            const p1 = p(segment.landmarks[0]);
            const p2 = p(segment.landmarks[1]);
            const dist_px = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
            const dist_cm = dist_px * cm_per_pixel;
            const mid_x = (p1.x + p2.x) / 2;
            const mid_y = (p1.y + p2.y) / 2;
            drawTextWithBackground(`${dist_cm.toFixed(1)} cm`, mid_x, mid_y);
          });

          angleDefinitions.forEach(def => {
            const angleValue = newAngles.find(a => a.name === def.name)?.angle;
            if (angleValue !== undefined) {
                drawAngleArc(...def.points);
                const vertex = def.points[1];
                drawTextWithBackground(`${angleValue}°`, vertex.x + 20, vertex.y - 20);
            }
          });
        }
      }

    } else {
      setCurrentAngles([]);
    }
    canvasCtx.restore();
  }, [userData]);

  const startCamera = useCallback(async () => {
    if (cameraRef.current) {
      cameraRef.current.stop();
    }
    if (!videoRef.current) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: useFrontCamera ? 'user' : 'environment' }
      });
      videoRef.current.srcObject = stream;
      await new Promise((resolve) => {
        if(videoRef.current) videoRef.current.onloadedmetadata = resolve;
      });

      const pose = new Pose({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
      pose.setOptions({
          modelComplexity: 1,
          smoothLandmarks: true,
          enableSegmentation: false,
          smoothSegmentation: true,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
      });
      pose.onResults(onResults);

      cameraRef.current = new Camera(videoRef.current, {
          onFrame: async () => {
            if (videoRef.current) await pose.send({ image: videoRef.current });
          },
          width: 1280,
          height: 720
      });
      cameraRef.current.start();
      setCameraReady(true);
      setIsLoading(false);
    } catch (err) {
      console.error("Error starting camera:", err);
      setIsLoading(false);
      alert(`Error al acceder a la cámara. Por favor, revisa los permisos. ${err}`);
    }
  }, [useFrontCamera, onResults]);

  useEffect(() => {
    if (userData) {
      startCamera();
      
      const unsubscribe = mockDb.onSnapshot((data: SavedPoseData[]) => {
          setSavedPoses(data);
          if (data.length >= 4) {
            setIsPhraseRecording(false);
          }
      });
      
      return () => {
        if (cameraRef.current) cameraRef.current.stop();
        unsubscribe();
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userData, startCamera]);

  // Effect for detecting pose stability
  useEffect(() => {
    if (!isPhraseRecording || isCapturing || savedPoses.length >= 4 || currentAngles.length === 0) {
      poseStabilityCounter.current = 0;
      return;
    }

    if (!lastStableAngles.current) {
      lastStableAngles.current = currentAngles;
      return;
    }

    const totalDiff = currentAngles.reduce((sum, angle, i) => {
      // Ensure lastStableAngles.current[i] exists to prevent errors
      const lastAngle = lastStableAngles.current?.[i]?.angle ?? angle.angle;
      return sum + Math.abs(angle.angle - lastAngle);
    }, 0);

    if (totalDiff < STABILITY_THRESHOLD) {
      poseStabilityCounter.current++;
    } else {
      poseStabilityCounter.current = 0;
    }
    
    lastStableAngles.current = currentAngles;

    if (poseStabilityCounter.current > STABILITY_DURATION_FRAMES) {
      triggerPoseCapture();
      poseStabilityCounter.current = 0; // Reset for the next pose
    }

  }, [currentAngles, isPhraseRecording, isCapturing, savedPoses.length]);


  const handleUserSetup = (data: UserData) => {
    setUserData(data);
  };

  const handleSwitchCamera = () => {
    setUseFrontCamera(prev => !prev);
  };
  
  const averageCapturedPoses = (poses: PoseAngle[][]): PoseAngle[] => {
      if (poses.length === 0) return [];
      const angleSums = new Map<string, number>();
      poses[0].forEach(a => angleSums.set(a.name, 0));
      poses.forEach(pose => pose.forEach(j => angleSums.set(j.name, (angleSums.get(j.name) || 0) + j.angle)));
      return Array.from(angleSums.keys()).map(name => ({ name, angle: Math.round(angleSums.get(name)! / poses.length) }));
  };

  const callGeminiAPI = async <T,>(prompt: string, responseSchema: any): Promise<T | null> => {
      try {
          const response = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: prompt,
              config: {
                  responseMimeType: "application/json",
                  responseSchema: responseSchema,
              },
          });
          return JSON.parse(response.text) as T;
      } catch (error) {
          console.error("Gemini API Error:", error);
          return null;
      }
  };

  const generatePoseNameWithAI = async (angles: PoseAngle[]): Promise<string> => {
    const angleDesc = angles.map(a => `${a.name}: ${a.angle}°`).join(', ');
    const prompt = `Eres un experto en kinésica. Nombra una postura basada en estos ángulos: ${angleDesc}. Usa un nombre de dos partes: un término kinésico (Emblema, Ilustrador, Regulador, Adaptador, Afectivo) y una palabra de intención (Poder, Duda, Invitación, Refugio, Expansión).`;
    const schema = { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: 'Término - Intención' } } };
    const result = await callGeminiAPI<{ name: string }>(prompt, schema);
    return result?.name || "Pose sin nombre";
  }

  const generatePoseHaikuWithAI = async (concept: string): Promise<string> => {
      const prompt = `Crea un haiku (formato 5-7-5 sílabas) inspirado en el concepto de lenguaje corporal "${concept}". El haiku debe ser evocador y poético.`;
      const schema = { type: Type.OBJECT, properties: { haiku: { type: Type.STRING, description: 'Línea 1\\nLínea 2\\nLínea 3' } } };
      const result = await callGeminiAPI<{ haiku: string }>(prompt, schema);
      return result?.haiku || "Silencio del cuerpo,\nviento que no dice nada,\nsombra en la pared.";
  }

  const handleStartPhraseRecording = () => {
    if (savedPoses.length < 4) {
      setIsPhraseRecording(true);
    }
  };
  
  const triggerPoseCapture = async () => {
    if (isCapturing || savedPoses.length >= 4 || currentAngles.length === 0) return;

    setIsCapturing(true);
    let currentCountdown = 8;
    setCountdown(currentCountdown);
    const capturedPoses: PoseAngle[][] = [];
    let imageSnapshot: string | null = null;
    
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if(videoRef.current) {
        tempCanvas.width = videoRef.current.videoWidth;
        tempCanvas.height = videoRef.current.videoHeight;
    }

    const intervalId = setInterval(() => {
        currentCountdown -= 1;
        setCountdown(currentCountdown);
        if (currentAngles.length > 0) capturedPoses.push([...currentAngles]);

        // Take snapshot early in the countdown
        if (currentCountdown === 5 && canvasRef.current && tempCtx) {
            tempCtx.save();
            tempCtx.translate(tempCanvas.width, 0);
            tempCtx.scale(-1, 1);
            tempCtx.drawImage(canvasRef.current, 0, 0, tempCanvas.width, tempCanvas.height);
            tempCtx.restore();
            imageSnapshot = tempCanvas.toDataURL('image/jpeg');
        }

        if (currentCountdown <= 0) {
            clearInterval(intervalId);
            setIsCapturing(false);
            setCountdown(8);

            if (capturedPoses.length < 5 || !imageSnapshot) {
                alert("No se pudo capturar la pose de forma estable.");
                return;
            }
            
            processAndSavePose(capturedPoses, imageSnapshot);
        }
    }, 1000);
  };

  const processAndSavePose = async (capturedPoses: PoseAngle[][], image: string) => {
      const averagedAngles = averageCapturedPoses(capturedPoses);
      const concept = await generatePoseNameWithAI(averagedAngles);
      const haiku = await generatePoseHaikuWithAI(concept);
      
      await mockDb.addDoc({
          concept,
          angles: averagedAngles,
          image,
          haiku,
          createdAt: new Date().toISOString()
      });
  };

  const comparePoses = (current: PoseAngle[], target: PoseAngle[]): number => {
      if (!current || !target || current.length !== target.length) return 0;
      const maxDiff = 45;
      const targetMap = new Map(target.map(i => [i.name, i.angle]));
      let similarity = 0;
      current.forEach(c => {
          if (targetMap.has(c.name)) {
              const diff = Math.abs(c.angle - targetMap.get(c.name)!);
              similarity += Math.max(0, 1 - (diff / maxDiff));
          }
      });
      return Math.round((similarity / current.length) * 100);
  };

  const showPoseSnapshot = (pose: SavedPoseData) => {
      setSnapshotImage(pose.image);
      setTimeout(() => setSnapshotImage(null), 5000);
  }

  const handleDownloadPdf = async () => {
    if (savedPoses.length < 4 || !userData) return;
    setIsGeneratingPdf(true);

    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 10;
    const contentWidth = pageWidth - (margin * 2);

    // Page 1: Title and Introduction
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(22);
    doc.text(`${userData.name}_Poses_UNIACC`, pageWidth / 2, 20, { align: 'center' });

    const poseConcepts = savedPoses.map(p => p.concept);
    const introPrompt = `Eres un filósofo al estilo socrático. Escribe una breve introducción narrativa (menos de 1000 caracteres) para un análisis de lenguaje corporal. El análisis explora las siguientes cuatro posturas: ${poseConcepts.join(', ')}. Utiliza preguntas para guiar al lector a reflexionar sobre cómo el cuerpo narra un viaje a través de estos diferentes estados. ¿Cómo un gesto puede transformarse de ${poseConcepts[0]} a ${poseConcepts[3]}? ¿Qué nos dice esta secuencia sobre nosotros mismos?`;
    const introSchema = { type: Type.OBJECT, properties: { introduction: { type: Type.STRING } } };
    const introResult = await callGeminiAPI<{ introduction: string }>(introPrompt, introSchema);
    const introduction = introResult?.introduction || "Observa tu cuerpo, el lienzo silencioso de tu alma. ¿Qué historias cuenta sin palabras?";
    
    doc.setFontSize(12);
    doc.setFont('Helvetica', 'italic');
    const introLines = doc.splitTextToSize(introduction, contentWidth);
    doc.text(introLines, pageWidth / 2, 40, { align: 'center' });

    // Subsequent pages: One for each pose
    for (const pose of savedPoses) {
        doc.addPage();
        let y = 30;

        const prompt = `Eres un astrólogo y experto en lenguaje corporal. Describe la siguiente postura en menos de 200 caracteres, interpretando su significado para una persona del signo ${userData.zodiac}. Postura: ${pose.angles.map(a => `${a.name}: ${a.angle}°`).join(', ')}. Sé poético y perspicaz.`;
        const schema = { type: Type.OBJECT, properties: { description: { type: Type.STRING } } };
        const result = await callGeminiAPI<{ description: string }>(prompt, schema);
        const description = result?.description || "No se pudo generar una descripción.";

        doc.setFontSize(18);
        doc.setFont('Helvetica', 'bold');
        doc.text(pose.concept, margin, y);
        y += 15;
        
        const imageHeight = contentWidth * (9 / 16); // Maintain 16:9 aspect ratio
        doc.addImage(pose.image, 'JPEG', margin, y, contentWidth, imageHeight);
        y += imageHeight + 15;

        doc.setFontSize(12);
        doc.setFont('Helvetica', 'italic');
        const haikuLines = doc.splitTextToSize(pose.haiku, contentWidth);
        doc.text(haikuLines, margin, y);
        y += (haikuLines.length * 6) + 10;

        doc.setFont('Helvetica', 'normal');
        const splitDesc = doc.splitTextToSize(description, contentWidth);
        doc.text(splitDesc, margin, y);
    }

    doc.save(`${userData.name}_Poses_UNIACC.pdf`);
    setIsGeneratingPdf(false);
  };

  if (!userData) {
    return <UserSetupModal onSubmit={handleUserSetup} zodiacSigns={ZODIAC_SIGNS} />;
  }

  const getButtonText = () => {
    if (isPhraseRecording) {
      return 'Grabando Frase (buscando pose estable...)';
    }
    return 'Comenzar a grabar una Frase';
  }

  return (
    <div className="bg-black text-white flex flex-col items-center min-h-screen p-4">
      {isCapturing && <CountdownModal countdown={countdown} />}
      <div className="w-full max-w-5xl mx-auto flex flex-col flex-grow">
        <h1 className="text-3xl md:text-4xl font-bold text-center mb-2 text-white">TALLER DE COMPOSICIÓN: CUERPO Y ESPACIO</h1>
        <div className="flex justify-center items-center mb-4">
          <p className="text-center text-gray-400">
            {userData ? `Hola, ${userData.name}. ¡Vamos a analizar tus posturas!` : 'Captura, nombra y analiza tus posturas corporales.'}
          </p>
          {isMobile && isCameraReady && (
            <button onClick={handleSwitchCamera} className="ml-4 bg-gray-800 p-2 border border-white rounded-md">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/><path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/><path d="m18 15-3-3 3-3"/><path d="m6 9 3 3-3 3"/></svg>
            </button>
          )}
        </div>

        <div className="relative flex-grow w-full flex items-center justify-center">
          {isLoading && <div className="text-center p-8 bg-gray-800 rounded-lg"><p>Cargando modelo y cámara...</p></div>}
          <div className={`container-video ${isLoading ? 'hidden' : ''}`}>
            <video ref={videoRef} className="input_video" autoPlay playsInline style={{ display: snapshotImage ? 'none' : 'block' }}></video>
            <canvas ref={canvasRef} className="output_canvas" style={{ display: snapshotImage ? 'none' : 'block' }}></canvas>
            {snapshotImage && <img src={snapshotImage} alt="Pose Snapshot" className="pose-snapshot object-cover" />}
          </div>
        </div>
      </div>

      <footer className="w-full max-w-5xl mx-auto mt-4">
        <button 
          onClick={handleStartPhraseRecording} 
          disabled={savedPoses.length >= 4 || isCapturing || isPhraseRecording}
          className="w-full bg-gray-800 hover:bg-gray-700 border border-white text-white font-bold py-3 px-4 shadow-md footer-button mb-2 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {getButtonText()}
        </button>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
          {Array.from({ length: 4 }).map((_, i) => {
            const pose = savedPoses[i];
            if (pose) {
              const match = comparePoses(currentAngles, pose.angles);
              const isSuccess = match > 90;
              return (
                <button 
                  key={pose.id}
                  onClick={() => showPoseSnapshot(pose)}
                  className={`footer-button bg-gray-800 border border-white text-white font-bold py-2 px-2 text-sm flex flex-col items-center justify-center h-24 relative rounded-lg ${isSuccess ? 'match-success' : ''}`}
                >
                  <span className="text-center">{pose.concept}</span>
                  <div className={`absolute bottom-1 right-1 text-xs font-mono ${isSuccess ? 'bg-gray-300' : 'bg-gray-600'} rounded-sm px-1`}>
                    {match}%
                  </div>
                </button>
              );
            }
            return (
              <div key={i} className="bg-gray-900 border border-dashed border-gray-600 text-gray-600 flex items-center justify-center h-24 rounded-lg">
                Pose {i + 1}
              </div>
            );
          })}
        </div>
        <button 
          onClick={handleDownloadPdf}
          disabled={savedPoses.length < 4 || isGeneratingPdf}
          className="w-full bg-gray-800 hover:bg-gray-700 border border-white text-white font-bold py-3 px-4 shadow-md footer-button rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isGeneratingPdf ? 'Generando PDF...' : 'Descargar Poses en PDF'}
        </button>
      </footer>
    </div>
  );
}