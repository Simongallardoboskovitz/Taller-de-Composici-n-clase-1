
import React from 'react';

interface CountdownModalProps {
  countdown: number;
}

const CountdownModal: React.FC<CountdownModalProps> = ({ countdown }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center z-50">
      <div className="bg-black border border-white p-8 shadow-2xl text-center rounded-lg">
        <h2 className="text-2xl font-bold text-white mb-4">Capturando Postura</h2>
        <p className="text-lg mb-6 text-gray-300">¡Mantén la pose! No te muevas.</p>
        <div className="text-7xl font-bold text-white">{countdown}</div>
      </div>
    </div>
  );
};

export default CountdownModal;
